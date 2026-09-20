// Planner — turns the Reconciler's flat ReconcileOperation list into a
// concrete ExecutionStep list. This is where API-shaped concerns live:
// batching in-diff comments into one review POST, routing out-of-diff
// comments to issue comments, bundling all file edits into one commit.
//
// See docs/adr/0003-operations-and-execution.md §3.

import { lineMapFor } from "./linemap";
import { BODY_LIMIT, envelopeOf, wireBodyLength } from "./metadata";
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
  SetIssueThreadResolvedStep,
  UnresolveReviewThreadStep,
} from "./steps";
import type { Comment, ErrorInfo, FileContent, FileEdit, PullRequest } from "./types";

/** Inputs the Planner needs that are not in the ReconcileOperation list itself. */
export type PlannerContext = {
  /** Routes a CreateComment to PostReviewBatch (in-diff) or PostIssueComment (out-of-diff). */
  isInDiff: (comment: Comment) => boolean;
  /** Current head sha; used as `commitId` for review batches and `baseSha` for commits. */
  headSha: string;
  /** Head ref (e.g. `refs/heads/topic` or just `topic`) for `updateRef`. */
  headRef: string;
  /** Repository that owns `headRef` — the fork for a fork PR (issue #273). */
  headRepo: { owner: string; repo: string };
  /** Sources at `(anchor.sha, path)` and `(headSha, path)` for the comments
   *  being planned; drives the re-anchoring of stale drafts to `headSha`. */
  fileContents: FileContent[];
  /** The PR being synced. Its lifecycle gates the commit: a merged or closed
   *  PR still accepts a push to its head ref, but the commit would never
   *  reach the base branch (issue #288). */
  pullRequest: PullRequest;
};

export function planExecution(ops: ReconcileOperation[], ctx: PlannerContext): ExecutionStep[] {
  const inDiff: Comment[] = [];
  const outOfDiff: Comment[] = [];
  const rejects: RejectCommentStep[] = [];
  const replies: PostReplyStep[] = [];
  const resolves: ResolveReviewThreadStep[] = [];
  const unresolves: UnresolveReviewThreadStep[] = [];
  const issueResolves: SetIssueThreadResolvedStep[] = [];
  const fileEdits: FileEdit[] = [];

  for (const op of ops) {
    switch (op.kind) {
      case "create-comment": {
        const comment = toHeadCoordinates(op.comment, ctx);
        if (comment === null) {
          rejects.push({ kind: "reject-comment", comment: op.comment, error: OUTDATED_ANCHOR });
        } else if (isTooLarge(comment)) {
          rejects.push({ kind: "reject-comment", comment: op.comment, error: BODY_TOO_LARGE });
        } else {
          (ctx.isInDiff(comment) ? inDiff : outOfDiff).push(comment);
        }
        break;
      }
      case "create-reply": {
        if (isTooLarge(op.comment)) {
          rejects.push({ kind: "reject-comment", comment: op.comment, error: BODY_TOO_LARGE });
          break;
        }
        // Routed on the GitHub object the parent actually became: a review
        // comment nests via the review-reply endpoint, while issue comments
        // are flat — there is no reply endpoint for them — so a reply to an
        // issue-comment parent is another issue comment that Bark ties to
        // the thread by its metadata threadId (issue #184). The current diff
        // must not decide this: a parent's creation-time lines drift in and
        // out of the diff as the author pushes (issue #285). The isInDiff
        // fallback only serves LocalState written before `remoteKind`
        // existed; the first refresh replaces those with the remote copy.
        const kind = op.parent.remoteKind ?? (ctx.isInDiff(op.parent) ? "review" : "issue");
        if (kind === "review") {
          replies.push({
            kind: "post-reply",
            comment: op.comment,
            parent: op.parent,
          });
        } else {
          outOfDiff.push(op.comment);
        }
        break;
      }
      case "update-thread-resolved":
        // Routed on the thread's remote identity: a review thread resolves
        // via GraphQL, an out-of-diff thread by rewriting its root issue
        // comment's metadata (issue #270).
        if (op.remoteIssueCommentId !== undefined) {
          issueResolves.push({
            kind: "set-issue-thread-resolved",
            threadId: op.threadId,
            issueCommentId: op.remoteIssueCommentId,
            resolved: op.desiredResolved,
          });
        } else if (op.remoteThreadId !== undefined) {
          const remoteThreadId = op.remoteThreadId;
          if (op.desiredResolved) {
            resolves.push({
              kind: "resolve-review-thread",
              threadId: op.threadId,
              remoteThreadId,
            });
          } else {
            unresolves.push({
              kind: "unresolve-review-thread",
              threadId: op.threadId,
              remoteThreadId,
            });
          }
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
  steps.push(...issueResolves);

  if (fileEdits.length > 0) {
    const closedReason = commitRefusalReason(ctx.pullRequest);
    if (closedReason) {
      steps.push({ kind: "reject-commit", fileEdits, error: { message: closedReason } });
    } else {
      const commit: CommitStep = {
        kind: "commit",
        baseSha: ctx.headSha,
        headRef: ctx.headRef,
        headRepo: ctx.headRepo,
        fileEdits,
      };
      steps.push(commit);
    }
  }

  return steps;
}

/** Why a commit must not go out, or null when the PR still accepts one.
 *  Comments are deliberately not gated: commenting on a merged or closed PR
 *  is a normal thing to do, so only the commit is refused (issue #288). */
function commitRefusalReason(pr: PullRequest): string | null {
  if (pr.merged) {
    return "The pull request is merged, so a commit to its branch would never reach the base branch.";
  }
  if (pr.state === "closed") {
    return "The pull request is closed, so a commit to its branch would never be reviewed or merged.";
  }
  return null;
}

/** A review batch is atomic, so an oversized comment would take every other
 *  comment in the same submit down with it (issue #279). Reject it alone. */
function isTooLarge(c: Comment): boolean {
  return wireBodyLength(c.body, envelopeOf(c)) > BODY_LIMIT;
}

const BODY_TOO_LARGE: ErrorInfo = {
  message:
    "This comment is too large for GitHub (limit 65,536 characters). Shorten the comment or split the suggestion.",
};

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
  const current = source(ctx.headSha) ?? "";
  const old = source(comment.anchor.sha) ?? null;
  const position = reanchor(
    comment.anchor,
    current,
    ctx.headSha,
    old,
    old === null || comment.anchor.sha === ctx.headSha
      ? undefined
      : lineMapFor(
          { oldSha: comment.anchor.sha, newSha: ctx.headSha, path: comment.path },
          old,
          current,
        ),
  );
  if (position.status === "current") return comment;
  if (position.status === "outdated") return null;
  return { ...comment, anchor: { ...comment.anchor, sha: ctx.headSha, range: position.range } };
}
