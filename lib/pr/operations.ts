// ReconcileOperation catalog.
// See docs/adr/0003-operations-and-execution.md §4.

import type { Comment, FileEdit, LocalId } from "./types";

/** A new top-level Comment ready to be posted to GitHub. */
export type CreateCommentOp = {
  kind: "create-comment";
  comment: Comment;
};

/** A reply Comment whose parent is already synced (has a remoteId). */
export type CreateReplyOp = {
  kind: "create-reply";
  comment: Comment;
  parent: Comment;
};

/** Thread.resolved differs from remote and the entity has been committed to sync.
 *  The Reconciler only emits this Op once the thread has a `remoteThreadId`,
 *  so the field is non-undefined here. */
export type UpdateThreadResolvedOp = {
  kind: "update-thread-resolved";
  threadId: LocalId;
  remoteThreadId: string;
  desiredResolved: boolean;
};

/** Pending file edit ready to be committed. */
export type CommitFileEditOp = {
  kind: "commit-file-edit";
  fileEdit: FileEdit;
};

export type ReconcileOperation =
  | CreateCommentOp
  | CreateReplyOp
  | UpdateThreadResolvedOp
  | CommitFileEditOp;
