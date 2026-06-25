// ExecutionStep catalog — the API-level units the Executor runs.
// See docs/adr/0003-operations-and-execution.md §5.

import type { Comment, FileEdit, LocalId } from "./types";

/** Atomic submission of N in-diff Comments via the GitHub review API. */
export type PostReviewBatchStep = {
  kind: "post-review-batch";
  /** Commit sha to anchor the review against (current `RemoteState.pullRequest.headSha`). */
  commitId: string;
  /** All in-diff Comments that became `syncing` in this cycle. */
  comments: Comment[];
};

/** Reply to a synced Comment via the review-comments endpoint. */
export type PostReplyStep = {
  kind: "post-reply";
  comment: Comment;
  parent: Comment;
};

/** A single out-of-diff Comment posted as an issue comment. */
export type PostIssueCommentStep = {
  kind: "post-issue-comment";
  comment: Comment;
};

/** Mark a review thread as resolved via GraphQL. */
export type ResolveReviewThreadStep = {
  kind: "resolve-review-thread";
  threadId: LocalId;
  remoteThreadId: string;
};

/** Mark a review thread as unresolved via GraphQL. */
export type UnresolveReviewThreadStep = {
  kind: "unresolve-review-thread";
  threadId: LocalId;
  remoteThreadId: string;
};

/** Commit all pending file edits in one atomic Git Data API sequence
 *  (blob → tree → commit → updateRef). */
export type CommitStep = {
  kind: "commit";
  /** Parent commit for the new commit. Current `RemoteState.pullRequest.headSha`. */
  baseSha: string;
  /** Ref to update (e.g. `refs/heads/topic`). */
  headRef: string;
  fileEdits: FileEdit[];
};

export type ExecutionStep =
  | PostReviewBatchStep
  | PostReplyStep
  | PostIssueCommentStep
  | ResolveReviewThreadStep
  | UnresolveReviewThreadStep
  | CommitStep;
