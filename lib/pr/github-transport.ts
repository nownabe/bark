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
    const mappings = await findCommentMappings(
      client,
      prRef,
      step.comments.map((c) => c.id),
    );
    return { ok: true, mappings };
  } catch (e) {
    return { ok: false, error: toErrorInfo(e) };
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

// ---- Commit (Git Data API) ---------------------------------------------

async function commit(
  client: GitHubClient,
  prRef: PrRef,
  step: CommitStep,
): Promise<CommitOutcome> {
  try {
    // A FileEdit records the head it was edited against (fe.baseSha). When
    // the PR head has advanced since (step.baseSha), committing the full
    // editedSource would silently revert any interim changes to that file
    // (issue #187). Allow the commit only when the file itself is unchanged
    // between the two shas (same blob); otherwise fail with a conflict the
    // UI can surface. Files whose baseSha matches the head need no check.
    for (const fe of step.fileEdits) {
      if (!fe.baseSha || fe.baseSha === step.baseSha) continue;
      const [before, after] = await Promise.all([
        fetchBlobSha(client, prRef, fe.path, fe.baseSha),
        fetchBlobSha(client, prRef, fe.path, step.baseSha),
      ]);
      if (before === null || after === null || before !== after) {
        return {
          ok: false,
          error: {
            message: `Conflict: ${fe.path} changed on the PR branch after your edit. Refresh the PR and re-apply your changes.`,
          },
        };
      }
    }
    const blobs = await Promise.all(
      step.fileEdits.map(async (fe) => {
        const result = await ghRequest<{ sha: string }>(
          client,
          "POST",
          `/repos/${prRef.owner}/${prRef.repo}/git/blobs`,
          { content: fe.editedSource, encoding: "utf-8" },
        );
        return { path: fe.path, sha: result.sha };
      }),
    );
    const tree = await ghRequest<{ sha: string }>(
      client,
      "POST",
      `/repos/${prRef.owner}/${prRef.repo}/git/trees`,
      {
        base_tree: step.baseSha,
        tree: blobs.map((b) => ({
          path: b.path,
          mode: "100644",
          type: "blob",
          sha: b.sha,
        })),
      },
    );
    const newCommit = await ghRequest<{ sha: string }>(
      client,
      "POST",
      `/repos/${prRef.owner}/${prRef.repo}/git/commits`,
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
      `/repos/${prRef.owner}/${prRef.repo}/git/refs/heads/${encodedHeadRef}`,
      { sha: newCommit.sha, force: false },
    );
    return { ok: true, newHeadSha: newCommit.sha };
  } catch (e) {
    return { ok: false, error: toErrorInfo(e) };
  }
}

function commitMessage(step: CommitStep): string {
  const paths = step.fileEdits.map((f) => f.path).join(", ");
  return `Apply edits to ${paths}`;
}

/** The blob sha of `path` at `ref`, or null when unreadable (deleted /
 *  moved) — the caller treats null as a conflict. Blob shas are
 *  content-addressed, so equality means the file is byte-identical. */
async function fetchBlobSha(
  client: GitHubClient,
  prRef: PrRef,
  path: string,
  ref: string,
): Promise<string | null> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  try {
    const res = await ghRequest<{ sha: string }>(
      client,
      "GET",
      `/repos/${prRef.owner}/${prRef.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    );
    return res.sha;
  } catch {
    return null;
  }
}

// ---- Identity matching -------------------------------------------------

/** After a review post, fetch the PR's review threads via GraphQL (all
 *  pages — see lib/pr/review-threads) and build cid → (remoteId,
 *  remoteThreadId) mappings for the freshly-posted comments by extracting
 *  hidden metadata from each comment body. */
async function findCommentMappings(
  client: GitHubClient,
  prRef: PrRef,
  cids: string[],
): Promise<CommentRemoteMapping[]> {
  if (cids.length === 0) return [];
  const threads = await listReviewThreads(client, prRef);
  const want = new Set(cids);
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
