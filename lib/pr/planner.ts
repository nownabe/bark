// Planner — turns the Reconciler's flat ReconcileOperation list into a
// concrete ExecutionStep list. This is where API-shaped concerns live:
// batching in-diff comments into one review POST, routing out-of-diff
// comments to issue comments, bundling all file edits into one commit.
//
// See docs/adr/0003-operations-and-execution.md §3.

import type { ReconcileOperation } from "./operations";
import type {
  CommitStep,
  ExecutionStep,
  PostIssueCommentStep,
  PostReplyStep,
  PostReviewBatchStep,
  ResolveReviewThreadStep,
  UnresolveReviewThreadStep,
} from "./steps";
import type { Comment, FileEdit } from "./types";

/** Inputs the Planner needs that are not in the ReconcileOperation list itself. */
export type PlannerContext = {
  /** Routes a CreateComment to PostReviewBatch (in-diff) or PostIssueComment (out-of-diff). */
  isInDiff: (comment: Comment) => boolean;
  /** Current head sha; used as `commitId` for review batches and `baseSha` for commits. */
  headSha: string;
  /** Head ref (e.g. `refs/heads/topic` or just `topic`) for `updateRef`. */
  headRef: string;
};

export function planExecution(ops: ReconcileOperation[], ctx: PlannerContext): ExecutionStep[] {
  const inDiff: Comment[] = [];
  const outOfDiff: Comment[] = [];
  const replies: PostReplyStep[] = [];
  const resolves: ResolveReviewThreadStep[] = [];
  const unresolves: UnresolveReviewThreadStep[] = [];
  const fileEdits: FileEdit[] = [];

  for (const op of ops) {
    switch (op.kind) {
      case "create-comment":
        (ctx.isInDiff(op.comment) ? inDiff : outOfDiff).push(op.comment);
        break;
      case "create-reply":
        // A reply to an in-diff review comment nests via the review-reply
        // endpoint. GitHub issue comments are flat — there is no reply
        // endpoint for them — so a reply to an out-of-diff (issue-comment)
        // parent must be posted as another issue comment; Bark reconstructs
        // the thread from the shared metadata threadId. Routing it to
        // post-reply would 404 on the issue-comment id (issue #184).
        if (ctx.isInDiff(op.parent)) {
          replies.push({
            kind: "post-reply",
            comment: op.comment,
            parent: op.parent,
          });
        } else {
          outOfDiff.push(op.comment);
        }
        break;
      case "update-thread-resolved":
        if (op.desiredResolved) {
          resolves.push({
            kind: "resolve-review-thread",
            threadId: op.threadId,
            remoteThreadId: op.remoteThreadId,
          });
        } else {
          unresolves.push({
            kind: "unresolve-review-thread",
            threadId: op.threadId,
            remoteThreadId: op.remoteThreadId,
          });
        }
        break;
      case "commit-file-edit":
        fileEdits.push(op.fileEdit);
        break;
    }
  }

  const steps: ExecutionStep[] = [];

  if (inDiff.length > 0) {
    const batch: PostReviewBatchStep = {
      kind: "post-review-batch",
      commitId: ctx.headSha,
      comments: inDiff,
    };
    steps.push(batch);
  }

  for (const c of outOfDiff) {
    const step: PostIssueCommentStep = {
      kind: "post-issue-comment",
      comment: c,
    };
    steps.push(step);
  }

  steps.push(...replies);
  steps.push(...resolves);
  steps.push(...unresolves);

  if (fileEdits.length > 0) {
    const commit: CommitStep = {
      kind: "commit",
      baseSha: ctx.headSha,
      headRef: ctx.headRef,
      fileEdits,
    };
    steps.push(commit);
  }

  return steps;
}
