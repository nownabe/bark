// Planner — turns the Reconciler's flat ReconcileOperation list into a
// concrete ExecutionStep list. This is where API-shaped concerns live:
// batching in-diff comments into one review POST, routing out-of-diff
// comments to issue comments, bundling all file edits into one commit.
//
// See docs/adr/0003-operations-and-execution.md §3.

import type { ReconcileOperation } from "./operations";
import { reanchor } from "./reanchor";
import type {
  CommitStep,
  ExecutionStep,
  PostIssueCommentStep,
  PostReplyStep,
  PostReviewBatchStep,
  RejectCommentStep,
  ResolveReviewThreadStep,
  UnresolveReviewThreadStep,
} from "./steps";
import type { Comment, ErrorInfo, FileContent, FileEdit } from "./types";

/** Inputs the Planner needs that are not in the ReconcileOperation list itself. */
export type PlannerContext = {
  /** Routes a CreateComment to PostReviewBatch (in-diff) or PostIssueComment (out-of-diff). */
  isInDiff: (comment: Comment) => boolean;
  /** Current head sha; used as `commitId` for review batches and `baseSha` for commits. */
  headSha: string;
  /** Head ref (e.g. `refs/heads/topic` or just `topic`) for `updateRef`. */
  headRef: string;
  /** Sources at `(anchor.sha, path)` and `(headSha, path)` for the comments
   *  being planned; drives the re-anchoring of stale drafts to `headSha`. */
  fileContents: FileContent[];
};

export function planExecution(ops: ReconcileOperation[], ctx: PlannerContext): ExecutionStep[] {
  const inDiff: Comment[] = [];
  const outOfDiff: Comment[] = [];
  const rejects: RejectCommentStep[] = [];
  const replies: PostReplyStep[] = [];
  const resolves: ResolveReviewThreadStep[] = [];
  const unresolves: UnresolveReviewThreadStep[] = [];
  const fileEdits: FileEdit[] = [];

  for (const op of ops) {
    switch (op.kind) {
      case "create-comment": {
        const comment = toHeadCoordinates(op.comment, ctx);
        if (comment === null) {
          rejects.push({ kind: "reject-comment", comment: op.comment, error: OUTDATED_ANCHOR });
        } else {
          (ctx.isInDiff(comment) ? inDiff : outOfDiff).push(comment);
        }
        break;
      }
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

  steps.push(...rejects);

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

const OUTDATED_ANCHOR: ErrorInfo = {
  message:
    "Could not map the commented lines to the current head commit. Refresh, or re-create the comment on the current text.",
};

/** A review is posted against one `commit_id` (the current head), so a draft
 *  anchored at an older sha must be posted with its line numbers mapped into
 *  the head — otherwise it lands on the wrong lines or 422s (issue #265).
 *  `Comment.anchor` itself stays immutable (ADR 0002 §2); only the posted
 *  copy is rebased. Returns null when the anchor cannot be mapped. */
function toHeadCoordinates(comment: Comment, ctx: PlannerContext): Comment | null {
  const source = (sha: string) =>
    ctx.fileContents.find((f) => f.sha === sha && f.path === comment.path)?.source;
  const position = reanchor(
    comment.anchor,
    source(ctx.headSha) ?? "",
    ctx.headSha,
    source(comment.anchor.sha) ?? null,
  );
  if (position.status === "current") return comment;
  if (position.status === "outdated") return null;
  return { ...comment, anchor: { ...comment.anchor, sha: ctx.headSha, range: position.range } };
}
