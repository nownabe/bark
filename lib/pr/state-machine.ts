// Pure state-machine transformations on LocalState.
//
// Three concerns:
//  - Transition helpers: flip drafts to syncing, set thread resolved
//  - Step result application: turn Executor outcomes into state updates per
//    the state machine (syncing → synced on ok, syncing → draft+error on fail)
//  - Refresh / conflict policy: merge RemoteState into LocalState
//
// See docs/adr/0001-pr-data-layer-architecture.md §3-§4
// and docs/adr/0003-operations-and-execution.md §6.

import type { StepResult } from "./executor";
import type { PostReviewBatchStep } from "./steps";
import type {
  CommentRemoteMapping,
  CommitOutcome,
  PostIssueCommentOutcome,
  PostReplyOutcome,
  PostReviewBatchOutcome,
  ResolveOutcome,
} from "./transport";
import type { Comment, ErrorInfo, LocalId, LocalState, RemoteState, Thread } from "./types";

/** Flip all draft Comments, Threads, and FileEdits to syncing.
 *  Called on user-initiated submission. */
export function flipDraftsToSyncing(local: LocalState): LocalState {
  return {
    ...local,
    comments: local.comments.map((c) =>
      c.state === "draft" ? { ...c, state: "syncing" as const, lastError: undefined } : c,
    ),
    threads: local.threads.map((t) =>
      t.state === "draft" ? { ...t, state: "syncing" as const, lastError: undefined } : t,
    ),
    fileEdits: local.fileEdits.map((f) =>
      f.state === "draft" ? { ...f, state: "syncing" as const, lastError: undefined } : f,
    ),
  };
}

/** Set a Thread's `resolved` field. If the Thread is currently `synced`, also
 *  transition it to `syncing` so the change is pushed. For `draft` and
 *  `syncing` states, just update the field without changing state. */
export function setThreadResolvedToSyncing(
  local: LocalState,
  id: LocalId,
  resolved: boolean,
): LocalState {
  return {
    ...local,
    threads: local.threads.map((t) => {
      if (t.id !== id) return t;
      if (t.state === "synced") {
        return { ...t, state: "syncing", resolved, lastError: undefined };
      }
      return { ...t, resolved };
    }),
  };
}

/** Apply step results to LocalState, advancing entities per the state machine. */
export function applyStepResults(local: LocalState, results: StepResult[]): LocalState {
  let next = local;
  for (const result of results) {
    next = applyStepResult(next, result);
  }
  return next;
}

function applyStepResult(local: LocalState, result: StepResult): LocalState {
  // The StepResult union pairs each step kind with its matching outcome shape,
  // but TypeScript does not narrow `result.outcome` from `result.step.kind`
  // alone. We restate the pairing with a cast inside each branch — safe
  // because the union's invariant guarantees it.
  switch (result.step.kind) {
    case "post-review-batch": {
      const o = result.outcome as PostReviewBatchOutcome;
      return o.ok
        ? applyReviewBatchSuccess(local, result.step, o.mappings)
        : applyReviewBatchFailure(local, result.step, o.error);
    }
    case "post-reply":
    case "post-issue-comment": {
      const o = result.outcome as PostReplyOutcome | PostIssueCommentOutcome;
      return o.ok
        ? applyCommentMapping(local, o.mapping)
        : applyCommentFailure(local, result.step.comment.id, o.error);
    }
    case "resolve-review-thread":
    case "unresolve-review-thread": {
      const o = result.outcome as ResolveOutcome;
      return o.ok
        ? applyThreadSyncSuccess(local, result.step.threadId)
        : applyThreadSyncFailure(local, result.step.threadId, o.error);
    }
    case "commit": {
      const o = result.outcome as CommitOutcome;
      const ids = result.step.fileEdits.map((f) => f.id);
      return o.ok ? applyCommitSuccess(local, ids) : applyCommitFailure(local, ids, o.error);
    }
  }
}

function applyReviewBatchSuccess(
  local: LocalState,
  step: PostReviewBatchStep,
  mappings: CommentRemoteMapping[],
): LocalState {
  const byCid = new Map(mappings.map((m) => [m.cid, m]));
  const threadRemotes = new Map<LocalId, string>();
  for (const m of mappings) {
    if (m.remoteThreadId) {
      const c = step.comments.find((x) => x.id === m.cid);
      if (c) threadRemotes.set(c.threadId, m.remoteThreadId);
    }
  }
  return {
    ...local,
    comments: local.comments.map((c) => {
      const m = byCid.get(c.id);
      if (!m) return c;
      return { ...c, state: "synced", remoteId: m.remoteId, lastError: undefined };
    }),
    threads: local.threads.map((t) => {
      const newRemoteThreadId = threadRemotes.get(t.id);
      if (t.state === "syncing" && newRemoteThreadId) {
        return {
          ...t,
          state: "synced",
          remoteThreadId: newRemoteThreadId,
          lastError: undefined,
        };
      }
      return t;
    }),
  };
}

function applyReviewBatchFailure(
  local: LocalState,
  step: PostReviewBatchStep,
  error: ErrorInfo,
): LocalState {
  const commentIds = new Set(step.comments.map((c) => c.id));
  const threadIds = new Set(step.comments.map((c) => c.threadId));
  return {
    ...local,
    comments: local.comments.map((c) =>
      commentIds.has(c.id) ? { ...c, state: "draft", lastError: error } : c,
    ),
    threads: local.threads.map((t) =>
      threadIds.has(t.id) && t.state === "syncing" && t.remoteThreadId === undefined
        ? { ...t, state: "draft", lastError: error }
        : t,
    ),
  };
}

function applyCommentMapping(local: LocalState, m: CommentRemoteMapping): LocalState {
  return {
    ...local,
    comments: local.comments.map((c) =>
      c.id === m.cid ? { ...c, state: "synced", remoteId: m.remoteId, lastError: undefined } : c,
    ),
  };
}

function applyCommentFailure(local: LocalState, cid: LocalId, error: ErrorInfo): LocalState {
  return {
    ...local,
    comments: local.comments.map((c) =>
      c.id === cid ? { ...c, state: "draft", lastError: error } : c,
    ),
  };
}

function applyThreadSyncSuccess(local: LocalState, threadId: LocalId): LocalState {
  return {
    ...local,
    threads: local.threads.map((t) =>
      t.id === threadId ? { ...t, state: "synced", lastError: undefined } : t,
    ),
  };
}

function applyThreadSyncFailure(
  local: LocalState,
  threadId: LocalId,
  error: ErrorInfo,
): LocalState {
  return {
    ...local,
    threads: local.threads.map((t) =>
      t.id === threadId ? { ...t, state: "draft", lastError: error } : t,
    ),
  };
}

function applyCommitSuccess(local: LocalState, fileEditIds: LocalId[]): LocalState {
  const ids = new Set(fileEditIds);
  return {
    ...local,
    fileEdits: local.fileEdits.filter((f) => !ids.has(f.id)),
  };
}

function applyCommitFailure(
  local: LocalState,
  fileEditIds: LocalId[],
  error: ErrorInfo,
): LocalState {
  const ids = new Set(fileEditIds);
  return {
    ...local,
    fileEdits: local.fileEdits.map((f) =>
      ids.has(f.id) ? { ...f, state: "draft", lastError: error } : f,
    ),
  };
}

/** Conflict policy for refresh: RemoteState wins for synced items, drafts and
 *  syncing items are protected. Synced local items absent from remote are
 *  silently dropped (GitHub deleted them).
 *
 *  See docs/adr/0001-pr-data-layer-architecture.md §4. */
export function mergeRemoteIntoLocal(local: LocalState, remote: RemoteState): LocalState {
  const newComments = mergeBy<Comment>(
    local.comments,
    remote.comments,
    (c) => c.state === "draft" || c.state === "syncing",
  );
  const newThreads = mergeBy<Thread>(
    local.threads,
    remote.threads,
    (t) => t.state === "draft" || t.state === "syncing",
  );
  return {
    ...local,
    comments: newComments,
    threads: newThreads,
  };
}

function mergeBy<T extends { id: LocalId }>(
  localItems: T[],
  remoteItems: T[],
  isProtected: (item: T) => boolean,
): T[] {
  const localById = new Map(localItems.map((x) => [x.id, x]));
  const result: T[] = [];
  for (const x of localItems) {
    if (isProtected(x)) result.push(x);
    // synced local items: drop here, the remote version (if any) is added below
  }
  for (const r of remoteItems) {
    const local = localById.get(r.id);
    if (!local || !isProtected(local)) {
      result.push(r);
    }
  }
  return result;
}
