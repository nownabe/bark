// RemoteFetcher — assembles a RemoteState from GitHub.
//
// Each entry point (fetchPullRequest, fetchViewer, fetchComments,
// fetchThreads, fetchFileContent) is exposed individually so callers
// can refetch a subset on demand. `fetchRemoteState` is the orchestrator
// that the Repository calls on bootstrap / refresh.
//
// See docs/adr/0005-refresh-policy.md §2 for what a full refresh covers.

import type { ChangedFile } from "./diff";
import { type GitHubClient, ghGraphQL, ghPaginate, ghRequest } from "./github-api";
import type { PrRef } from "./github-transport";
import { extractMetadata } from "./metadata";
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

/** Fetch the PR's review comments + issue comments and normalise both to
 *  the unified `Comment` shape. Bark-authored comments roundtrip their
 *  cid / threadId / anchor via hidden metadata; foreign comments get a
 *  synthetic id and an empty anchor so they appear in the sidebar but
 *  do not pin to a line. */
export async function fetchComments(client: GitHubClient, ref: PrRef): Promise<Comment[]> {
  const [reviewRaw, issueRaw] = await Promise.all([
    ghPaginate<RawReviewComment>(
      client,
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments?per_page=100`,
    ),
    ghPaginate<RawIssueComment>(
      client,
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100`,
    ),
  ]);
  const reviewById = new Map(reviewRaw.map((c) => [c.id, c]));
  const out: Comment[] = [];
  for (const rc of reviewRaw) {
    out.push(toCommentFromReview(rc, reviewById));
  }
  for (const ic of issueRaw) {
    out.push(toCommentFromIssue(ic));
  }
  return out;
}

function toCommentFromReview(rc: RawReviewComment, byId: Map<number, RawReviewComment>): Comment {
  const { body, meta } = extractMetadata(rc.body);
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
  return {
    id: `foreign-review-${rc.id}`,
    state: "synced",
    remoteId: rc.id,
    threadId: `foreign-thread-review-${rc.id}`,
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

function toCommentFromIssue(ic: RawIssueComment): Comment {
  const { body, meta } = extractMetadata(ic.body);
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

const LIST_THREADS_QUERY = `
  query ListReviewThreads($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
                databaseId
                body
              }
            }
          }
        }
      }
    }
  }
`;

type ListThreadsResponse = {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{
          id: string;
          isResolved: boolean;
          comments: {
            nodes: Array<{ databaseId: number; body: string }>;
          };
        }>;
      };
    };
  };
};

/** Fetch review threads. For each GraphQL thread, find a constituent
 *  comment carrying hidden metadata and use its `threadId` as the local
 *  Thread.id; otherwise synthesise one keyed off `remoteThreadId`. */
export async function fetchThreads(client: GitHubClient, ref: PrRef): Promise<Thread[]> {
  const data = await ghGraphQL<ListThreadsResponse>(client, LIST_THREADS_QUERY, {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
  });
  return data.repository.pullRequest.reviewThreads.nodes.map((t) => {
    const localId = findThreadLocalId(t);
    return {
      id: localId,
      state: "synced",
      remoteThreadId: t.id,
      resolved: t.isResolved,
    };
  });
}

function findThreadLocalId(thread: {
  id: string;
  comments: { nodes: Array<{ body: string }> };
}): string {
  for (const c of thread.comments.nodes) {
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
  /** Past-sha file contents to populate for re-anchoring. The orchestrator
   *  fetches each `(sha, path)` pair as part of the bootstrap so AppState's
   *  re-anchoring derivation has the inputs it needs. */
  fileContentTargets?: Array<{ sha: string; path: string }>;
};

/** Build a RemoteState from one parallel fetch round. */
export async function fetchRemoteState(
  client: GitHubClient,
  ref: PrRef,
  opts: FetchRemoteStateOptions = {},
): Promise<RemoteState> {
  const [pullRequest, viewer, comments, threads] = await Promise.all([
    fetchPullRequest(client, ref),
    fetchViewer(client),
    fetchComments(client, ref),
    fetchThreads(client, ref),
  ]);
  const targets = opts.fileContentTargets ?? [];
  const fileContents = await Promise.all(
    targets.map((t) => fetchFileContent(client, ref, t.sha, t.path)),
  );
  return {
    pullRequest,
    viewer,
    comments,
    threads,
    fileEdits: [],
    fileContents,
  };
}
