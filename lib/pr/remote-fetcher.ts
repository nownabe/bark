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
  created_at?: string;
};

type RawIssueComment = {
  id: number;
  body: string;
  user: RawUser;
  created_at?: string;
};

// ---- Fence identity binding (issue #190) --------------------------------
//
// The metadata fence is plaintext-base64 inside a publicly readable comment
// body, so any PR commenter can copy another comment's cid / threadId into
// their own fence. Identity is therefore bound to the earliest bearer: for
// each cid and threadId, the first comment (by created_at, across review AND
// issue comments) that carried it is its owner. A later comment bearing an
// owned cid is demoted to foreign, and a review thread's local id is honored
// only when the owning comment sits inside that very thread — so a forged
// fence can neither displace the real comment nor pull other comments into
// the forger's thread. (A forged fence merely *joining* an existing
// out-of-diff thread is indistinguishable from the legitimate issue-comment
// reply flow of #184 and stays allowed; GitHub shows the real author.)

type FenceOwners = {
  cid: Map<string, string>;
  threadId: Map<string, string>;
};

const reviewOwnerKey = (restId: number) => `review-${restId}`;
const issueOwnerKey = (restId: number) => `issue-${restId}`;

function buildFenceOwners(reviewRaw: RawReviewComment[], issueRaw: RawIssueComment[]): FenceOwners {
  const cidBest = new Map<string, OwnerCandidate>();
  const threadBest = new Map<string, OwnerCandidate>();
  let index = 0;
  const consider = (key: string, body: string, createdAt: string | undefined) => {
    const i = index++;
    const { meta } = extractMetadata(body);
    if (!meta) return;
    const candidate: OwnerCandidate = { key, createdAt, index: i };
    claimIfEarlier(cidBest, meta.cid, candidate);
    claimIfEarlier(threadBest, meta.threadId, candidate);
  };
  for (const c of reviewRaw) consider(reviewOwnerKey(c.id), c.body, c.created_at);
  for (const c of issueRaw) consider(issueOwnerKey(c.id), c.body, c.created_at);
  return { cid: ownerKeys(cidBest), threadId: ownerKeys(threadBest) };
}

type OwnerCandidate = { key: string; createdAt?: string; index: number };

function claimIfEarlier(best: Map<string, OwnerCandidate>, id: string, c: OwnerCandidate): void {
  const prev = best.get(id);
  if (!prev || isEarlier(c, prev)) best.set(id, c);
}

/** ISO-8601 created_at compares lexicographically. GitHub always sends it;
 *  an absent one sorts last so an undated fence never displaces a dated
 *  bearer. Ties fall back to fetch order (review pages before issue pages). */
function isEarlier(a: OwnerCandidate, b: OwnerCandidate): boolean {
  if (a.createdAt !== b.createdAt) {
    if (a.createdAt === undefined) return false;
    if (b.createdAt === undefined) return true;
    return a.createdAt < b.createdAt;
  }
  return a.index < b.index;
}

function ownerKeys(best: Map<string, OwnerCandidate>): Map<string, string> {
  return new Map(Array.from(best, ([id, c]) => [id, c.key]));
}

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
 *  `threadLocalIdByCommentId` maps a review comment's REST id to the LOCAL
 *  id of the review thread it belongs to — the same id `fetchThreads` gives
 *  the Thread entity (a contained Bark comment's metadata threadId, else the
 *  synthesised `foreign-thread-<nodeId>`). Foreign comments adopt it as
 *  their `threadId`, so every review comment satisfies
 *  `comment.threadId === Thread.id`: comments in one GitHub thread stay
 *  grouped — including native replies to Bark threads — (issue #181) and
 *  their resolved state is surfaced (issue #180). Pass an empty map when
 *  the thread data isn't available; foreign comments then fall back to a
 *  per-comment thread id. */
export function normalizeComments(
  reviewRaw: RawReviewComment[],
  issueRaw: RawIssueComment[],
  threadLocalIdByCommentId: ReadonlyMap<number, string> = new Map(),
): Comment[] {
  const reviewById = new Map(reviewRaw.map((c) => [c.id, c]));
  const owners = buildFenceOwners(reviewRaw, issueRaw);
  const out: Comment[] = [];
  for (const rc of reviewRaw) {
    const c = toCommentFromReview(rc, reviewById, threadLocalIdByCommentId, owners);
    if (c) out.push(c);
  }
  for (const ic of issueRaw) {
    const c = toCommentFromIssue(ic, owners);
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
  threadLocalIdByCommentId: ReadonlyMap<number, string>,
  owners: FenceOwners,
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
      ? localIdForReview(byId.get(rc.in_reply_to_id) ?? null, rc.in_reply_to_id, owners)
      : undefined;
  if (meta && owners.cid.get(meta.cid) === reviewOwnerKey(rc.id)) {
    return {
      id: meta.cid,
      state: "synced",
      remoteId: rc.id,
      // Prefer GitHub's own thread grouping over the fence value so a
      // forged threadId cannot re-home the comment (issue #190); the two
      // agree for every legitimately posted comment.
      threadId: threadLocalIdByCommentId.get(rc.id) ?? meta.threadId,
      parentLocalId,
      body,
      author,
      path: meta.path,
      anchor: meta.anchor,
    };
  }
  // Foreign review comment (or a fence whose cid an earlier comment owns —
  // a forged copy, issue #190) — preserve as much position info as we can,
  // but leave quote empty so re-anchoring reports `outdated`. When the
  // GitHub `line` field is null (the comment's original line no longer
  // exists in the head — i.e. it's outdated / diff-outside), encode
  // that as `sl/el = 0`. The legacy UI (and any consumer that treats
  // the comment as "renderable in the editor") should treat range.el
  // === 0 as "no anchor known". The UI may then choose to hide the
  // comment entirely (Bark currently does — it's scope is line-bound
  // comments only) or render it elsewhere.
  const headLine = rc.line ?? 0;
  // Adopt the thread's local id (via the map) so the comment matches the
  // Thread entity from fetchThreads — for a mixed thread that's the Bark
  // metadata threadId, for an all-foreign one the synthesised
  // foreign-thread-<nodeId>. Fall back to the comment's own id only when
  // the thread data is unavailable.
  const threadLocalId = threadLocalIdByCommentId.get(rc.id);
  return {
    id: `foreign-review-${rc.id}`,
    state: "synced",
    remoteId: rc.id,
    threadId: threadLocalId ?? `foreign-thread-review-${rc.id}`,
    parentLocalId,
    // `body` (not rc.body): identical for true foreign comments, and strips
    // the forged fence from a demoted one.
    body,
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

function localIdForReview(
  parent: RawReviewComment | null,
  parentRemoteId: number,
  owners: FenceOwners,
): string {
  if (parent) {
    const { meta } = extractMetadata(parent.body);
    if (meta && owners.cid.get(meta.cid) === reviewOwnerKey(parent.id)) return meta.cid;
  }
  return `foreign-review-${parentRemoteId}`;
}

function toCommentFromIssue(ic: RawIssueComment, owners: FenceOwners): Comment | null {
  const { body, meta } = extractMetadata(ic.body);
  // Legacy out-of-diff resolves posted the marker as an issue comment; drop
  // it the same way (issue #186).
  if (meta?.legacyResolveEvent) return null;
  const author = { login: ic.user.login, avatarUrl: ic.user.avatar_url };
  if (meta && owners.cid.get(meta.cid) === issueOwnerKey(ic.id)) {
    return {
      id: meta.cid,
      state: "synced",
      remoteId: ic.id,
      // meta.threadId is kept as-is: issue comments have no GitHub thread
      // structure to validate against, and sharing another thread's id is
      // exactly how legitimate out-of-diff replies work (issue #184).
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
    body,
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
 *  keyed off `remoteThreadId`.
 *
 *  Review threads only: out-of-diff (issue-comment) threads have no GraphQL
 *  thread and are synthesised by `fetchRemoteState`, which has the REST
 *  issue-comment data this entry point does not fetch. */
export async function fetchThreads(client: GitHubClient, ref: PrRef): Promise<Thread[]> {
  return threadsFromRaw(await listReviewThreads(client, ref));
}

/** Thread entities for out-of-diff conversations: an issue comment that is
 *  the earliest bearer of its `threadId` is that thread's root, and its
 *  hidden `resolved` flag is the thread's resolved state (issue #270). A
 *  later comment reusing the threadId is a reply, never the root, so it can
 *  neither create a second Thread nor resolve someone else's (issue #190).
 *  `taken` holds the review threads' local ids, so a fence naming one of
 *  them (a reply to an in-diff thread, #184; or a fence forging a
 *  synthesised `foreign-thread-*` id) never yields a second Thread entity. */
function issueThreadsFromRaw(
  issueRaw: RawIssueComment[],
  owners: FenceOwners,
  taken: ReadonlySet<string>,
): Thread[] {
  const out: Thread[] = [];
  for (const ic of issueRaw) {
    const { meta } = extractMetadata(ic.body);
    if (!meta || meta.legacyResolveEvent) continue;
    if (taken.has(meta.threadId)) continue;
    if (owners.threadId.get(meta.threadId) !== issueOwnerKey(ic.id)) continue;
    out.push({
      id: meta.threadId,
      state: "synced",
      remoteIssueCommentId: ic.id,
      resolved: meta.resolved === true,
    });
  }
  return out;
}

function threadsFromRaw(raw: RawReviewThread[], owners?: FenceOwners): Thread[] {
  const localIds = threadLocalIds(raw, owners);
  return raw.map((t) => ({
    id: localIds.get(t.id) ?? `foreign-thread-${t.id}`,
    state: "synced",
    remoteThreadId: t.id,
    resolved: t.isResolved,
  }));
}

/** Local id per thread node id, deduplicated: the first thread claiming a
 *  local id keeps it; a later claimant (a forged fence duplicating another
 *  thread's id, issue #190) falls back to its synthesised foreign id so two
 *  Thread entities never collide. */
function threadLocalIds(raw: RawReviewThread[], owners?: FenceOwners): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const t of raw) {
    let id = findThreadLocalId(t, owners);
    if (used.has(id)) id = `foreign-thread-${t.id}`;
    used.add(id);
    out.set(t.id, id);
  }
  return out;
}

/** Map each review comment's REST id to the LOCAL id of the review thread
 *  it belongs to — the same id `threadsFromRaw` gives the Thread entity.
 *  Foreign comments adopt it as their `threadId` so a thread's comments and
 *  its Thread entity always share one key, whether the thread is
 *  all-foreign or mixed (a native reply inside a Bark thread inherits the
 *  Bark threadId; issues #180 / #181 / #183). */
function buildCommentThreadMap(raw: RawReviewThread[], owners?: FenceOwners): Map<number, string> {
  const localIds = threadLocalIds(raw, owners);
  const map = new Map<number, string>();
  for (const t of raw) {
    const localId = localIds.get(t.id);
    if (localId === undefined) continue;
    for (const c of t.comments) map.set(c.databaseId, localId);
  }
  return map;
}

/** With `owners` (the fetchRemoteState path), a fence names its thread only
 *  when the naming comment is the earliest bearer of that threadId — a
 *  forged fence cannot name someone else's thread, including an out-of-diff
 *  (issue-comment) thread's id (issue #190). Without owners (standalone
 *  fetchThreads, no REST comment data) the fence is trusted as before and
 *  only the `threadLocalIds` dedup applies. */
function findThreadLocalId(thread: RawReviewThread, owners?: FenceOwners): string {
  for (const c of thread.comments) {
    const { meta } = extractMetadata(c.body);
    if (!meta) continue;
    if (owners && owners.threadId.get(meta.threadId) !== reviewOwnerKey(c.databaseId)) continue;
    return meta.threadId;
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
  /** Already-known authenticated user. When provided, the `/user` fetch is
   *  skipped and this value is used verbatim — per ADR 0005 §2 the viewer
   *  is fetched once at bootstrap and not refreshed (it changes only on
   *  re-auth). */
  viewer?: User;
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
    opts.viewer ? Promise.resolve(opts.viewer) : fetchViewer(client),
    fetchReviewCommentsRaw(client, ref),
    fetchIssueCommentsRaw(client, ref),
    listReviewThreads(client, ref),
  ]);
  const owners = buildFenceOwners(reviewRaw, issueRaw);
  const comments = normalizeComments(
    reviewRaw,
    issueRaw,
    buildCommentThreadMap(rawThreads, owners),
  );
  const threads = threadsFromRaw(rawThreads, owners);
  const taken = new Set(threads.map((t) => t.id));
  threads.push(...issueThreadsFromRaw(issueRaw, owners, taken));

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
  // Re-anchoring maps anchor.sha → headSha, so every anchored path is also
  // needed at the head (issue #265).
  for (const t of Array.from(targetSet.values())) {
    targetSet.set(`${pullRequest.headSha}\0${t.path}`, { sha: pullRequest.headSha, path: t.path });
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
