// RemoteFetcher — assembles a RemoteState from GitHub.
//
// Each entry point (fetchPullRequest, fetchViewer, fetchComments,
// fetchThreads, fetchFileContent) is exposed individually so callers
// can refetch a subset on demand. `fetchRemoteState` is the orchestrator
// that the Repository calls on bootstrap / refresh.
//
// See docs/adr/0005-refresh-policy.md §2 for what a full refresh covers.

import type { ChangedFile } from "./diff";
import { type GitHubClient, ghPaginate, ghRequest } from "./github-api";
import type { PrRef } from "./github-transport";
import { extractMetadata } from "./metadata";
import { listReviewThreads, type RawReviewThread } from "./review-threads";
import type { Comment, FileContent, PullRequest, RemoteState, Thread, User } from "./types";

// ---- PullRequest -------------------------------------------------------

type RawPull = {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  head: { sha: string; ref: string };
  base: { ref: string };
  user: { login: string; avatar_url: string };
};

export async function fetchPullRequest(client: GitHubClient, ref: PrRef): Promise<PullRequest> {
  const raw = await ghRequest<RawPull>(
    client,
    "GET",
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
  );
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: raw.title,
    body: raw.body ?? "",
    headSha: raw.head.sha,
    headRef: raw.head.ref,
    baseRef: raw.base.ref,
    state: raw.state,
    draft: raw.draft,
    merged: raw.merged,
    author: { login: raw.user.login, avatarUrl: raw.user.avatar_url },
  };
}

// ---- Viewer ------------------------------------------------------------

type RawUser = { login: string; avatar_url: string };

export async function fetchViewer(client: GitHubClient): Promise<User> {
  const raw = await ghRequest<RawUser>(client, "GET", "/user");
  return { login: raw.login, avatarUrl: raw.avatar_url };
}

// ---- Comments ----------------------------------------------------------

type RawReviewComment = {
  id: number;
  body: string;
  path: string;
  line: number | null;
  start_line?: number | null;
  in_reply_to_id?: number;
  user: RawUser;
};

type RawIssueComment = {
  id: number;
  body: string;
  user: RawUser;
};

function fetchReviewCommentsRaw(client: GitHubClient, ref: PrRef): Promise<RawReviewComment[]> {
  return ghPaginate<RawReviewComment>(
    client,
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments?per_page=100`,
  );
}

function fetchIssueCommentsRaw(client: GitHubClient, ref: PrRef): Promise<RawIssueComment[]> {
  return ghPaginate<RawIssueComment>(
    client,
    `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100`,
  );
}

/** Normalise raw review + issue comments to the unified `Comment` shape.
 *  `threadNodeIdByCommentId` maps a review comment's REST id to the GraphQL
 *  node id of the review thread it belongs to; it is what lets a foreign
 *  comment's `threadId` line up with the Thread entity `fetchThreads`
 *  synthesises (both keyed `foreign-thread-<nodeId>`), so foreign comments
 *  in one GitHub thread stay grouped (issue #181) and their resolved state
 *  is surfaced (issue #180). Pass an empty map when the thread data isn't
 *  available; foreign comments then fall back to a per-comment thread id. */
export function normalizeComments(
  reviewRaw: RawReviewComment[],
  issueRaw: RawIssueComment[],
  threadNodeIdByCommentId: ReadonlyMap<number, string> = new Map(),
): Comment[] {
  const reviewById = new Map(reviewRaw.map((c) => [c.id, c]));
  const out: Comment[] = [];
  for (const rc of reviewRaw) {
    const c = toCommentFromReview(rc, reviewById, threadNodeIdByCommentId);
    if (c) out.push(c);
  }
  for (const ic of issueRaw) {
    const c = toCommentFromIssue(ic);
    if (c) out.push(c);
  }
  return out;
}

/** Fetch the PR's review + issue comments and normalise both to the
 *  unified `Comment` shape. Bark-authored comments roundtrip their cid /
 *  threadId / anchor via hidden metadata; foreign comments get a synthetic
 *  id and an empty anchor so they appear in the sidebar but do not pin to a
 *  line. Called standalone (no thread data), so foreign comments fall back
 *  to a per-comment threadId; `fetchRemoteState` supplies the thread map. */
export async function fetchComments(client: GitHubClient, ref: PrRef): Promise<Comment[]> {
  const [reviewRaw, issueRaw] = await Promise.all([
    fetchReviewCommentsRaw(client, ref),
    fetchIssueCommentsRaw(client, ref),
  ]);
  return normalizeComments(reviewRaw, issueRaw);
}

function toCommentFromReview(
  rc: RawReviewComment,
  byId: Map<number, RawReviewComment>,
  threadNodeIdByCommentId: ReadonlyMap<number, string>,
): Comment | null {
  const { body, meta } = extractMetadata(rc.body);
  // A legacy v1 resolve marker is a hidden control comment, not a message —
  // drop it so it doesn't render as a thread reply (issue #186).
  if (meta?.legacyResolveEvent) return null;
  const author = { login: rc.user.login, avatarUrl: rc.user.avatar_url };
  // Reply chains: GitHub gives `in_reply_to_id` (REST id of parent). We
  // resolve to the parent's local id by looking up its metadata's cid.
  const parentLocalId =
    rc.in_reply_to_id !== undefined
      ? localIdForReview(byId.get(rc.in_reply_to_id) ?? null, rc.in_reply_to_id)
      : undefined;
  if (meta) {
    return {
      id: meta.cid,
      state: "synced",
      remoteId: rc.id,
      threadId: meta.threadId,
      parentLocalId,
      body,
      author,
      path: meta.path,
      anchor: meta.anchor,
    };
  }
  // Foreign review comment — preserve as much position info as we can,
  // but leave quote empty so re-anchoring reports `outdated`. When the
  // GitHub `line` field is null (the comment's original line no longer
  // exists in the head — i.e. it's outdated / diff-outside), encode
  // that as `sl/el = 0`. The legacy UI (and any consumer that treats
  // the comment as "renderable in the editor") should treat range.el
  // === 0 as "no anchor known". The UI may then choose to hide the
  // comment entirely (Bark currently does — it's scope is line-bound
  // comments only) or render it elsewhere.
  const headLine = rc.line ?? 0;
  // Key the thread off the GraphQL review-thread node id (via the map) so
  // it matches the Thread entity from fetchThreads. Fall back to the
  // comment's own id only when the thread data is unavailable.
  const threadNodeId = threadNodeIdByCommentId.get(rc.id);
  return {
    id: `foreign-review-${rc.id}`,
    state: "synced",
    remoteId: rc.id,
    threadId: threadNodeId ? `foreign-thread-${threadNodeId}` : `foreign-thread-review-${rc.id}`,
    parentLocalId,
    body: rc.body,
    author,
    path: rc.path,
    anchor: {
      sha: "",
      range: {
        sl: rc.start_line ?? headLine,
        sc: 1,
        el: headLine,
        ec: 1,
      },
      quote: "",
    },
  };
}

function localIdForReview(parent: RawReviewComment | null, parentRemoteId: number): string {
  if (parent) {
    const { meta } = extractMetadata(parent.body);
    if (meta) return meta.cid;
  }
  return `foreign-review-${parentRemoteId}`;
}

function toCommentFromIssue(ic: RawIssueComment): Comment | null {
  const { body, meta } = extractMetadata(ic.body);
  // Legacy out-of-diff resolves posted the marker as an issue comment; drop
  // it the same way (issue #186).
  if (meta?.legacyResolveEvent) return null;
  const author = { login: ic.user.login, avatarUrl: ic.user.avatar_url };
  if (meta) {
    return {
      id: meta.cid,
      state: "synced",
      remoteId: ic.id,
      threadId: meta.threadId,
      body,
      author,
      path: meta.path,
      anchor: meta.anchor,
    };
  }
  return {
    id: `foreign-issue-${ic.id}`,
    state: "synced",
    remoteId: ic.id,
    threadId: `foreign-thread-issue-${ic.id}`,
    body: ic.body,
    author,
    path: "",
    anchor: {
      sha: "",
      range: { sl: 1, sc: 1, el: 1, ec: 1 },
      quote: "",
    },
  };
}

// ---- Threads -----------------------------------------------------------

/** Fetch review threads (all pages — see lib/pr/review-threads). For each
 *  GraphQL thread, find a constituent comment carrying hidden metadata and
 *  use its `threadId` as the local Thread.id; otherwise synthesise one
 *  keyed off `remoteThreadId`. */
export async function fetchThreads(client: GitHubClient, ref: PrRef): Promise<Thread[]> {
  return threadsFromRaw(await listReviewThreads(client, ref));
}

function threadsFromRaw(raw: RawReviewThread[]): Thread[] {
  return raw.map((t) => ({
    id: findThreadLocalId(t),
    state: "synced",
    remoteThreadId: t.id,
    resolved: t.isResolved,
  }));
}

/** Map each review comment's REST id to the GraphQL node id of the review
 *  thread it belongs to. Used to align foreign comments' `threadId` with
 *  the synthesised Thread entity (issues #180 / #181). */
function buildCommentThreadMap(raw: RawReviewThread[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const t of raw) {
    for (const c of t.comments) map.set(c.databaseId, t.id);
  }
  return map;
}

function findThreadLocalId(thread: RawReviewThread): string {
  for (const c of thread.comments) {
    const { meta } = extractMetadata(c.body);
    if (meta) return meta.threadId;
  }
  return `foreign-thread-${thread.id}`;
}

// ---- ChangedFiles ------------------------------------------------------

type RawChangedFile = {
  filename: string;
  status: ChangedFile["status"];
  patch?: string;
};

/** Fetch the PR's changed files with their unified-diff patches. Used to
 *  build the `isInDiff` predicate that routes CreateComment ops between
 *  PostReviewBatch and PostIssueComment. */
export async function fetchChangedFiles(client: GitHubClient, ref: PrRef): Promise<ChangedFile[]> {
  const raw = await ghPaginate<RawChangedFile>(
    client,
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`,
  );
  return raw.map((f) => ({
    path: f.filename,
    status: f.status,
    patch: f.patch,
  }));
}

// ---- FileContent -------------------------------------------------------

type RawContents = { content: string; encoding: "base64" };

export async function fetchFileContent(
  client: GitHubClient,
  ref: PrRef,
  sha: string,
  path: string,
): Promise<FileContent> {
  // Encode each path segment individually — `encodeURIComponent` on the
  // whole path turns "/" into "%2F", which GitHub rejects with 404.
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const raw = await ghRequest<RawContents>(
    client,
    "GET",
    `/repos/${ref.owner}/${ref.repo}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`,
  );
  return {
    sha,
    path,
    source: decodeBase64Utf8(raw.content),
  };
}

function decodeBase64Utf8(b64: string): string {
  // GitHub returns base64 with line breaks every 60 chars.
  const cleaned = b64.replace(/\s+/g, "");
  const bin = atob(cleaned);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---- Orchestrator ------------------------------------------------------

export type FetchRemoteStateOptions = {
  /** Extra past-sha file contents to populate beyond the ones implied by
   *  the fetched comments. Callers use this for anchors that aren't
   *  already represented in the fetched RemoteState (typically draft-
   *  authored comments that live only in LocalState). The orchestrator
   *  automatically also collects targets from every fetched comment's
   *  `anchor.(sha, path)` so the re-anchoring derivation has its LCS
   *  inputs for submitted comments without the caller having to know
   *  them up front. */
  fileContentTargets?: Array<{ sha: string; path: string }>;
};

/** Build a RemoteState from one parallel fetch round.
 *
 *  The file-content fetch is a second sub-round because we can only know
 *  every needed `(sha, path)` pair AFTER the comments come back — but
 *  the result is still a single, fully-populated RemoteState that the
 *  caller pushes to the Repository with one `setRemoteState`. No
 *  intermediate partial RemoteState is ever observed. */
export async function fetchRemoteState(
  client: GitHubClient,
  ref: PrRef,
  opts: FetchRemoteStateOptions = {},
): Promise<RemoteState> {
  // Fetch every raw source in parallel, then normalise. The review-thread
  // data is needed both to build Thread entities and to key foreign
  // comments' threadId off their GraphQL thread node id, so comment
  // normalisation waits on the raw fetch (not on a second round trip).
  const [pullRequest, viewer, reviewRaw, issueRaw, rawThreads] = await Promise.all([
    fetchPullRequest(client, ref),
    fetchViewer(client),
    fetchReviewCommentsRaw(client, ref),
    fetchIssueCommentsRaw(client, ref),
    listReviewThreads(client, ref),
  ]);
  const comments = normalizeComments(reviewRaw, issueRaw, buildCommentThreadMap(rawThreads));
  const threads = threadsFromRaw(rawThreads);

  // Union of:
  //   - every fetched comment's anchor (foreign comments with anchor.sha
  //     === "" or empty path are skipped — they can't be re-anchored)
  //   - caller-provided extras (draft anchors not yet in the fetched list)
  const targetSet = new Map<string, { sha: string; path: string }>();
  for (const c of comments) {
    if (c.anchor.sha && c.path) {
      targetSet.set(`${c.anchor.sha}\0${c.path}`, { sha: c.anchor.sha, path: c.path });
    }
  }
  for (const t of opts.fileContentTargets ?? []) {
    if (t.sha && t.path) {
      targetSet.set(`${t.sha}\0${t.path}`, t);
    }
  }
  const targets = Array.from(targetSet.values());

  // A 404 on one file (the sha + path no longer exists at GitHub) is
  // not fatal: the corresponding comment will fall back to `outdated`
  // via the missing-fileContent path in lib/pr/reanchor — same behaviour
  // as before this auto-collect existed.
  const settled = await Promise.allSettled(
    targets.map((t) => fetchFileContent(client, ref, t.sha, t.path)),
  );
  const fileContents: FileContent[] = settled
    .filter((r): r is PromiseFulfilledResult<FileContent> => r.status === "fulfilled")
    .map((r) => r.value);

  return {
    pullRequest,
    viewer,
    comments,
    threads,
    fileEdits: [],
    fileContents,
  };
}
