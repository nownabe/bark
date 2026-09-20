// Transport interface — the boundary between the Executor (which orchestrates
// state changes) and the actual GitHub API (which speaks HTTP / GraphQL / Git
// Data API and handles hidden-metadata encoding).
//
// The Executor depends on this interface only; concrete implementations
// (real GitHub transport, fake for tests, mock for other backends) live elsewhere.

import type { ErrorInfo, LocalId } from "./types";
import type {
  CommitStep,
  PostIssueCommentStep,
  PostReplyStep,
  PostReviewBatchStep,
  ResolveReviewThreadStep,
  SetIssueThreadResolvedStep,
  UnresolveReviewThreadStep,
} from "./steps";

/** Identifier mapping returned after a successful comment post. */
export type CommentRemoteMapping = {
  /** The local Comment.id that was submitted. */
  cid: LocalId;
  /** The GitHub REST id assigned to the new comment. */
  remoteId: number;
  /** When the post created a new thread, the GraphQL node id of that thread. */
  remoteThreadId?: string;
};

/** `ok: true` means the review POST succeeded. `mappings` may still miss
 *  some cids: the identity listing lagged behind the write, or failed
 *  outright (`confirmError`). Either way the comments exist on GitHub, so
 *  this must not be reported as `ok: false` — a plain retry would post them
 *  again (issue #266). */
export type PostReviewBatchOutcome =
  | { ok: true; mappings: CommentRemoteMapping[]; confirmError?: ErrorInfo }
  | { ok: false; error: ErrorInfo };

export type PostReplyOutcome =
  | { ok: true; mapping: CommentRemoteMapping }
  | { ok: false; error: ErrorInfo };

export type PostIssueCommentOutcome =
  | { ok: true; mapping: CommentRemoteMapping }
  | { ok: false; error: ErrorInfo };

export type ResolveOutcome = { ok: true } | { ok: false; error: ErrorInfo };

export type CommitOutcome = { ok: true; newHeadSha: string } | { ok: false; error: ErrorInfo };

/** All the GitHub-side operations the Executor needs.
 *  Each method is total: it never throws; transport-level failures are
 *  reported as `{ ok: false, error }`. This keeps the Executor's
 *  failure-handling rule (`syncing → draft + lastError`) uniform. */
export interface Transport {
  postReviewBatch(step: PostReviewBatchStep): Promise<PostReviewBatchOutcome>;
  postReply(step: PostReplyStep): Promise<PostReplyOutcome>;
  postIssueComment(step: PostIssueCommentStep): Promise<PostIssueCommentOutcome>;
  resolveReviewThread(step: ResolveReviewThreadStep): Promise<ResolveOutcome>;
  unresolveReviewThread(step: UnresolveReviewThreadStep): Promise<ResolveOutcome>;
  setIssueThreadResolved(step: SetIssueThreadResolvedStep): Promise<ResolveOutcome>;
  commit(step: CommitStep): Promise<CommitOutcome>;
}
