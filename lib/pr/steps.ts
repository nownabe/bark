// ExecutionStep catalog — the API-level units the Executor runs.
// See docs/adr/0003-operations-and-execution.md §5.

import type { Comment, ErrorInfo, FileEdit, LocalId } from "./types";

/** Atomic submission of N in-diff Comments via the GitHub review API. */
export type PostReviewBatchStep = {
  kind: "post-review-batch";
  /** Commit sha to anchor the review against (current `RemoteState.pullRequest.headSha`). */
  commitId: string;
  /** All in-diff Comments that became `syncing` in this cycle. */
  comments: Comment[];
};

/** A Comment the Planner refused to post because its anchor cannot be mapped
 *  into the current head (issue #265). It never reaches the Transport; the
 *  Executor reports it as a failed outcome so the state machine returns the
 *  Comment (and its unposted Thread) to `draft` with `lastError`. */
export type RejectCommentStep = {
  kind: "reject-comment";
  comment: Comment;
  error: ErrorInfo;
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

/** Set an out-of-diff thread's resolved state by rewriting the hidden
 *  metadata of its root issue comment. Issue comments have no GraphQL
 *  review thread, so this is where their resolved state lives (issue #270). */
export type SetIssueThreadResolvedStep = {
  kind: "set-issue-thread-resolved";
  threadId: LocalId;
  /** REST id of the thread's root issue comment. */
  issueCommentId: number;
  resolved: boolean;
};

/** Commit all pending file edits in one atomic Git Data API sequence
 *  (blob → tree → commit → updateRef). */
export type CommitStep = {
  kind: "commit";
  /** Parent commit for the new commit. Current `RemoteState.pullRequest.headSha`. */
  baseSha: string;
  /** Ref to update (e.g. `refs/heads/topic`). */
  headRef: string;
  /** Repository that owns `headRef`; the fork for fork PRs. */
  headRepo: { owner: string; repo: string };
  fileEdits: FileEdit[];
};

/** The FileEdits the Planner refused to commit because the PR is no longer
 *  open (issue #288). It never reaches the Transport; the Executor reports it
 *  as a failed outcome so the state machine parks the FileEdits back as
 *  `draft` with `lastError` instead of clearing the author's work. */
export type RejectCommitStep = {
  kind: "reject-commit";
  fileEdits: FileEdit[];
  error: ErrorInfo;
};

export type ExecutionStep =
  | PostReviewBatchStep
  | RejectCommentStep
  | PostReplyStep
  | PostIssueCommentStep
  | ResolveReviewThreadStep
  | UnresolveReviewThreadStep
  | SetIssueThreadResolvedStep
  | CommitStep
  | RejectCommitStep;
