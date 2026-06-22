// Author-mode Submit orchestration.
//
// The author flow mirrors reviewer Submit: every action (comment, reply,
// accept suggestion, edit) is staged locally, then flushed in one go. On the
// GitHub side this collapses to three operations + a follow-up:
//
//   1. Post in-diff comments as a single review (submitReview) and
//      out-of-diff comments as separate PR (issue) comments. Their anchors
//      target the pre-commit head sha — correct, since the new commit hasn't
//      shifted lines yet.
//   2. Post replies to existing threads (replyToReviewComment).
//   3. Make ONE commit that includes every edited file and every accepted
//      suggestion's applied source (createBlob × N → createTree → createCommit
//      → updateRef on the head ref). Trees use base_tree=baseSha so unchanged
//      files inherit from the head commit.
//   4. Resolve the threads of accepted suggestions (resolveReviewThread,
//      GraphQL). These run AFTER the commit so they show up alongside it on
//      GitHub; failures here are non-fatal — we collect them and let the
//      caller surface a warning.
//
// Earlier stages failing aborts later ones (e.g. an updateRef 422 must not
// also drop the author's pending state). The caller maps the thrown error's
// `stage` to the right cleanup policy.
import type { GitHubClient, PrRef, ReviewCommentInput } from "./github";

export interface AuthorSubmitInput {
  client: Pick<
    GitHubClient,
    | "submitReview"
    | "createIssueComment"
    | "replyToReviewComment"
    | "createBlob"
    | "createTree"
    | "createCommit"
    | "updateRef"
    | "resolveReviewThread"
  >;
  ref: PrRef;
  /** PR head ref to fast-forward (e.g. "feature/foo"). */
  branch: string;
  /** Head sha before this Submit; becomes the commit parent + tree base_tree. */
  baseSha: string;
  /** In-diff comment drafts → posted as one review. */
  reviewComments: ReviewCommentInput[];
  /** Out-of-diff comment drafts → each posted as a regular PR comment. */
  issueBodies: string[];
  /** Reply drafts → posted via replyToReviewComment into existing threads. */
  replies: { rootCommentId: number; body: string }[];
  /** Files included in the single batched commit (any source !== base). */
  files: { path: string; content: string }[];
  /** Commit message (the caller composes an aggregated body if useful). */
  commitMessage: string;
  /**
   * Threads to resolve after the commit. For each: post a Bark resolve-event
   * metadata reply (so the local sidebar still treats the thread as resolved
   * after the dismissed map is cleared) THEN call the GraphQL resolve so the
   * native GitHub UI matches. The caller composes `eventBody` with embedded
   * `event: "resolve"` metadata — mirrors setThreadResolved's flow.
   */
  acceptedThreads: { rootCommentId: number; threadNodeId: string; eventBody: string }[];
}

export interface AuthorSubmitResult {
  /** The new head sha if a commit was made, else the input baseSha unchanged. */
  newHeadSha: string;
  /** Resolve failures — non-fatal; the caller decides whether to surface them. */
  resolveErrors: { threadId: string; error: unknown }[];
}

export type AuthorSubmitStage = "comments" | "replies" | "commit";

/** Thrown when a stage before resolve fails. Carries the stage for cleanup logic. */
export class AuthorSubmitError extends Error {
  constructor(
    public readonly stage: AuthorSubmitStage,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "AuthorSubmitError";
  }
}

export async function executeAuthorSubmit(input: AuthorSubmitInput): Promise<AuthorSubmitResult> {
  const { client, ref } = input;

  // 1) Comments
  try {
    if (input.reviewComments.length > 0) {
      await client.submitReview(ref, {
        commitId: input.baseSha,
        comments: input.reviewComments,
      });
    }
    for (const body of input.issueBodies) {
      await client.createIssueComment(ref, body);
    }
  } catch (e) {
    throw new AuthorSubmitError("comments", e);
  }

  // 2) Replies
  try {
    for (const r of input.replies) {
      await client.replyToReviewComment(ref, r.rootCommentId, r.body);
    }
  } catch (e) {
    throw new AuthorSubmitError("replies", e);
  }

  // 3) Commit
  let newHeadSha = input.baseSha;
  if (input.files.length > 0) {
    try {
      const sorted = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
      const entries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
      for (const f of sorted) {
        const sha = await client.createBlob(ref, f.content);
        entries.push({ path: f.path, mode: "100644", type: "blob", sha });
      }
      const treeSha = await client.createTree(ref, { baseTree: input.baseSha, entries });
      const commitSha = await client.createCommit(ref, {
        message: input.commitMessage,
        tree: treeSha,
        parents: [input.baseSha],
      });
      await client.updateRef(ref, input.branch, commitSha);
      newHeadSha = commitSha;
    } catch (e) {
      throw new AuthorSubmitError("commit", e);
    }
  }

  // 4) Resolve (non-fatal: collect and return).
  // Per accepted thread: post the Bark resolve-event metadata reply FIRST so
  // the local sidebar survives the dismissed-map cleanup, then call the
  // GraphQL resolve so GitHub's native UI matches. If the event reply fails,
  // skip the GraphQL resolve for that thread — doing it would leave the local
  // UI re-emerging (the bug this stage exists to prevent) — but keep going on
  // remaining threads so partial progress lands.
  const resolveErrors: { threadId: string; error: unknown }[] = [];
  for (const t of input.acceptedThreads) {
    try {
      await client.replyToReviewComment(ref, t.rootCommentId, t.eventBody);
    } catch (e) {
      resolveErrors.push({ threadId: t.threadNodeId, error: e });
      continue;
    }
    try {
      await client.resolveReviewThread(t.threadNodeId);
    } catch (e) {
      resolveErrors.push({ threadId: t.threadNodeId, error: e });
    }
  }

  return { newHeadSha, resolveErrors };
}
