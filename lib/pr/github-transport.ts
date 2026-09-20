// GitHub-backed Transport implementation. Each ExecutionStep is dispatched
// to the matching set of GitHub REST / GraphQL calls; hidden metadata is
// embedded on every posted comment so the Reconciler can match remote ids
// back to LocalState by `cid`.
//
// See docs/adr/0003-operations-and-execution.md §5 for the per-Step
// GitHub API mapping and §7 for the identity-matching contract.

import { type GitHubClient, ghGraphQL, GitHubApiError, ghRequest } from "./github-api";
import { embedMetadata, extractMetadata } from "./metadata";
import { listReviewThreads } from "./review-threads";
import type {
  CommitStep,
  PostIssueCommentStep,
  PostReplyStep,
  PostReviewBatchStep,
  ResolveReviewThreadStep,
  SetIssueThreadResolvedStep,
  UnresolveReviewThreadStep,
} from "./steps";
import type {
  CommentRemoteMapping,
  CommitOutcome,
  PostIssueCommentOutcome,
  PostReplyOutcome,
  PostReviewBatchOutcome,
  ResolveOutcome,
  Transport,
} from "./transport";
import type { Comment, ErrorInfo } from "./types";

export type PrRef = {
  owner: string;
  repo: string;
  number: number;
};

export function createGitHubTransport(client: GitHubClient, prRef: PrRef): Transport {
  return {
    postReviewBatch: (step) => postReviewBatch(client, prRef, step),
    postReply: (step) => postReply(client, prRef, step),
    postIssueComment: (step) => postIssueComment(client, prRef, step),
    resolveReviewThread: (step) => resolveReviewThread(client, step),
    unresolveReviewThread: (step) => unresolveReviewThread(client, step),
    setIssueThreadResolved: (step) => setIssueThreadResolved(client, prRef, step),
    commit: (step) => commit(client, prRef, step),
  };
}

// ---- PostReviewBatch ----------------------------------------------------

async function postReviewBatch(
  client: GitHubClient,
  prRef: PrRef,
  step: PostReviewBatchStep,
): Promise<PostReviewBatchOutcome> {
  try {
    const comments = step.comments.map((c) => buildReviewCommentInput(c));
    await ghRequest(
      client,
      "POST",
      `/repos/${prRef.owner}/${prRef.repo}/pulls/${prRef.number}/reviews`,
      { commit_id: step.commitId, event: "COMMENT", comments },
    );
  } catch (e) {
    return { ok: false, error: toErrorInfo(e) };
  }
  try {
    const mappings = await findCommentMappings(
      client,
      prRef,
      step.comments.map((c) => c.id),
    );
    return { ok: true, mappings };
  } catch (e) {
    return { ok: true, mappings: [], confirmError: toErrorInfo(e) };
  }
}

function buildReviewCommentInput(c: Comment) {
  const body = embedMetadata(c.body, {
    cid: c.id,
    threadId: c.threadId,
    path: c.path,
    anchor: c.anchor,
  });
  const base = {
    path: c.path,
    line: c.anchor.range.el,
    side: "RIGHT" as const,
    body,
  };
  if (c.anchor.range.sl !== c.anchor.range.el) {
    return { ...base, start_line: c.anchor.range.sl, start_side: "RIGHT" as const };
  }
  return base;
}

// ---- PostReply ---------------------------------------------------------

async function postReply(
  client: GitHubClient,
  prRef: PrRef,
  step: PostReplyStep,
): Promise<PostReplyOutcome> {
  try {
    if (step.parent.remoteId === undefined) {
      throw new Error("postReply: parent has no remoteId");
    }
    const body = embedMetadata(step.comment.body, {
      cid: step.comment.id,
      threadId: step.comment.threadId,
      path: step.comment.path,
      anchor: step.comment.anchor,
    });
    const result = await ghRequest<{ id: number }>(
      client,
      "POST",
      `/repos/${prRef.owner}/${prRef.repo}/pulls/${prRef.number}/comments/${step.parent.remoteId}/replies`,
      { body },
    );
    return {
      ok: true,
      mapping: { cid: step.comment.id, remoteId: result.id },
    };
  } catch (e) {
    return { ok: false, error: toErrorInfo(e) };
  }
}

// ---- PostIssueComment --------------------------------------------------

async function postIssueComment(
  client: GitHubClient,
  prRef: PrRef,
  step: PostIssueCommentStep,
): Promise<PostIssueCommentOutcome> {
  try {
    const body = embedMetadata(step.comment.body, {
      cid: step.comment.id,
      threadId: step.comment.threadId,
      path: step.comment.path,
      anchor: step.comment.anchor,
    });
    const result = await ghRequest<{ id: number }>(
      client,
      "POST",
      `/repos/${prRef.owner}/${prRef.repo}/issues/${prRef.number}/comments`,
      { body },
    );
    return {
      ok: true,
      mapping: { cid: step.comment.id, remoteId: result.id },
    };
  } catch (e) {
    return { ok: false, error: toErrorInfo(e) };
  }
}

// ---- Resolve / Unresolve -----------------------------------------------

const RESOLVE_MUTATION = `
  mutation ResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id }
    }
  }
`;

const UNRESOLVE_MUTATION = `
  mutation UnresolveReviewThread($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) {
      thread { id }
    }
  }
`;

async function resolveReviewThread(
  client: GitHubClient,
  step: ResolveReviewThreadStep,
): Promise<ResolveOutcome> {
  try {
    await ghGraphQL(client, RESOLVE_MUTATION, { threadId: step.remoteThreadId });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toErrorInfo(e) };
  }
}

async function unresolveReviewThread(
  client: GitHubClient,
  step: UnresolveReviewThreadStep,
): Promise<ResolveOutcome> {
  try {
    await ghGraphQL(client, UNRESOLVE_MUTATION, { threadId: step.remoteThreadId });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toErrorInfo(e) };
  }
}

/** Out-of-diff threads have no GraphQL review thread, so their resolved
 *  state lives in the hidden metadata of the thread's root issue comment:
 *  re-embed the fence with `resolved` and PATCH the comment. Identity fields
 *  come from the FETCHED fence, so a stale local copy cannot rewrite them;
 *  a v1 fence is upgraded to v2 and `legacyResolveEvent` is dropped. */
async function setIssueThreadResolved(
  client: GitHubClient,
  prRef: PrRef,
  step: SetIssueThreadResolvedStep,
): Promise<ResolveOutcome> {
  const url = `/repos/${prRef.owner}/${prRef.repo}/issues/comments/${step.issueCommentId}`;
  try {
    // simplify: read-modify-write without a precondition — a concurrent edit
    // of the root comment between GET and PATCH is overwritten. Upgrade path:
    // carry `updated_at` from the GET into a conditional PATCH and retry once.
    const current = await ghRequest<{ body: string }>(client, "GET", url);
    const { body, meta } = extractMetadata(current.body);
    if (!meta) {
      return {
        ok: false,
        error: {
          message:
            "The thread's root comment no longer carries Bark metadata; it cannot be resolved from Bark.",
        },
      };
    }
    const next = embedMetadata(body, {
      cid: meta.cid,
      threadId: meta.threadId,
      path: meta.path,
      anchor: meta.anchor,
      resolved: step.resolved,
    });
    await ghRequest(client, "PATCH", url, { body: next });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toErrorInfo(e) };
  }
}

// ---- Commit (Git Data API) ---------------------------------------------

async function commit(
  client: GitHubClient,
  prRef: PrRef,
  step: CommitStep,
): Promise<CommitOutcome> {
  try {
    const treeCache = new Map<string, Promise<Map<string, TreeBlob>>>();
    const treeAt = (ref: string): Promise<Map<string, TreeBlob>> => {
      const cached = treeCache.get(ref);
      if (cached) return cached;
      const pending = fetchTreeBlobs(client, prRef, ref);
      treeCache.set(ref, pending);
      return pending;
    };
    const baseTree = await treeAt(step.baseSha);

    // A FileEdit records the head it was edited against (fe.baseSha). When
    // the PR head has advanced since (step.baseSha), committing the full
    // editedSource would silently revert any interim changes to that file
    // (issue #187). Allow the commit only when the file itself is unchanged
    // between the two shas (same blob); otherwise fail with a conflict the
    // UI can surface. Files whose baseSha matches the head need no check.
    for (const fe of step.fileEdits) {
      if (!fe.baseSha || fe.baseSha === step.baseSha) continue;
      const before = (await treeAt(fe.baseSha)).get(fe.path);
      const after = baseTree.get(fe.path);
      if (!before || !after || before.sha !== after.sha) {
        return {
          ok: false,
          error: {
            message: `Conflict: ${fe.path} changed on the PR branch after your edit. Refresh the PR and re-apply your changes.`,
          },
        };
      }
    }
    // Reads stay on the base repository, which can address every commit of
    // the PR by sha; only the writes go to the repository that owns headRef —
    // the fork for a fork PR (issue #273).
    const head = step.headRepo;
    const blobs = await Promise.all(
      step.fileEdits.map(async (fe) => {
        const result = await ghRequest<{ sha: string }>(
          client,
          "POST",
          `/repos/${head.owner}/${head.repo}/git/blobs`,
          { content: fe.editedSource, encoding: "utf-8" },
        );
        return { path: fe.path, sha: result.sha };
      }),
    );
    const tree = await ghRequest<{ sha: string }>(
      client,
      "POST",
      `/repos/${head.owner}/${head.repo}/git/trees`,
      {
        base_tree: step.baseSha,
        tree: blobs.map((b) => ({
          path: b.path,
          // Reuse the file's existing mode so an executable file does not lose
          // its bit; 100644 is only the mode for a path the tree doesn't have.
          mode: baseTree.get(b.path)?.mode ?? "100644",
          type: "blob",
          sha: b.sha,
        })),
      },
    );
    const newCommit = await ghRequest<{ sha: string }>(
      client,
      "POST",
      `/repos/${head.owner}/${head.repo}/git/commits`,
      {
        message: commitMessage(step),
        tree: tree.sha,
        parents: [step.baseSha],
      },
    );
    // Per-segment encoding so a branch like "topic/feature" survives.
    const encodedHeadRef = step.headRef.split("/").map(encodeURIComponent).join("/");
    await ghRequest(
      client,
      "PATCH",
      `/repos/${head.owner}/${head.repo}/git/refs/heads/${encodedHeadRef}`,
      { sha: newCommit.sha, force: false },
    );
    return { ok: true, newHeadSha: newCommit.sha };
  } catch (e) {
    return { ok: false, error: forkAwareError(e, prRef, step.headRepo) };
  }
}

/** A 403/404 while writing to a *different* repository than the PR's base is
 *  almost always missing access to the fork — for an App token, the App not
 *  being installed there. Say so instead of echoing GitHub's bare "Not Found". */
function forkAwareError(
  e: unknown,
  prRef: PrRef,
  head: { owner: string; repo: string },
): ErrorInfo {
  const info = toErrorInfo(e);
  const isFork = head.owner !== prRef.owner || head.repo !== prRef.repo;
  if (!isFork || (info.code !== 403 && info.code !== 404)) return info;
  return {
    ...info,
    message: `Bark cannot write to ${head.owner}/${head.repo}. Install the Bark GitHub App on that repository, or sign in with a personal access token, then try again.`,
  };
}

function commitMessage(step: CommitStep): string {
  const paths = step.fileEdits.map((f) => f.path).join(", ");
  return `Apply edits to ${paths}`;
}

type TreeBlob = { sha: string; mode: string };

/** Every blob in the tree at `ref`, keyed by path. Read from the Git Trees
 *  API rather than `/contents`, which answers a file over 1 MB with no usable
 *  sha and so turned a large file into a spurious conflict (issue #292).
 *  It also carries each entry's mode, which the new tree reuses.
 *
 *  A path absent from the map was deleted or moved — the caller treats that
 *  as a conflict, as it did when `/contents` 404'd.
 *
 *  simplify: a repository with more than ~100k entries comes back `truncated`,
 *  and every path past the cut then reads as deleted. Upgrade path: walk the
 *  tree one path segment at a time (non-recursive) for the edited paths only. */
async function fetchTreeBlobs(
  client: GitHubClient,
  prRef: PrRef,
  ref: string,
): Promise<Map<string, TreeBlob>> {
  const res = await ghRequest<{
    tree: { path: string; mode: string; type: string; sha: string }[];
  }>(
    client,
    "GET",
    `/repos/${prRef.owner}/${prRef.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  );
  const blobs = new Map<string, TreeBlob>();
  for (const entry of res.tree) {
    if (entry.type === "blob") blobs.set(entry.path, { sha: entry.sha, mode: entry.mode });
  }
  return blobs;
}

// ---- Identity matching -------------------------------------------------

/** GitHub's listing can lag behind the review POST (read-after-write); a
 *  cid missing from the first listing usually appears within a second or
 *  two. Bounded so a comment GitHub really dropped does not hang the
 *  submit; the caller reports whatever is still unmapped (ADR 0003 §7). */
const CONFIRM_BACKOFF_MS = [500, 1500];
const defaultDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** After a review post, fetch the PR's review threads via GraphQL (all
 *  pages — see lib/pr/review-threads) and build cid → (remoteId,
 *  remoteThreadId) mappings for the freshly-posted comments by extracting
 *  hidden metadata from each comment body. Re-lists with backoff while
 *  any cid is still missing. */
async function findCommentMappings(
  client: GitHubClient,
  prRef: PrRef,
  cids: string[],
): Promise<CommentRemoteMapping[]> {
  if (cids.length === 0) return [];
  const sleep = client.delay ?? defaultDelay;
  let out: CommentRemoteMapping[] = [];
  for (let attempt = 0; ; attempt++) {
    out = await listCommentMappings(client, prRef, new Set(cids));
    if (out.length === cids.length || attempt === CONFIRM_BACKOFF_MS.length) return out;
    await sleep(CONFIRM_BACKOFF_MS[attempt]);
  }
}

async function listCommentMappings(
  client: GitHubClient,
  prRef: PrRef,
  want: Set<string>,
): Promise<CommentRemoteMapping[]> {
  const threads = await listReviewThreads(client, prRef);
  const out: CommentRemoteMapping[] = [];
  for (const thread of threads) {
    for (const c of thread.comments) {
      const { meta } = extractMetadata(c.body);
      if (meta && want.has(meta.cid)) {
        out.push({
          cid: meta.cid,
          remoteId: c.databaseId,
          remoteThreadId: thread.id,
        });
      }
    }
  }
  return out;
}

// ---- Error mapping -----------------------------------------------------

function toErrorInfo(e: unknown): ErrorInfo {
  if (e instanceof GitHubApiError) {
    return { message: e.message, code: e.status, detail: e.detail };
  }
  if (e instanceof Error) {
    return { message: e.message };
  }
  return { message: String(e) };
}
