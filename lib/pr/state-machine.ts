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

/** Set a Thread's `resolved` field. If the Thread is currently `synced` —
 *  or `draft` with a remoteThreadId, i.e. it exists on GitHub but a prior
 *  sync failed — also transition it to `syncing` so the change is pushed;
 *  without the draft case a failed resolve could never be retried (issue
 *  #188). A true draft (no remoteThreadId yet) just updates the field:
 *  it syncs with the next submit. */
export function setThreadResolvedToSyncing(
  local: LocalState,
  id: LocalId,
  resolved: boolean,
): LocalState {
  return {
    ...local,
    threads: local.threads.map((t) => {
      if (t.id !== id) return t;
      if (t.state === "synced" || (t.state === "draft" && t.remoteThreadId !== undefined)) {
        return { ...t, state: "syncing", resolved, lastError: undefined };
      }
      return { ...t, resolved };
    }),
  };
}

/** Complete "nothing to push" thread syncs. A `syncing` Thread whose desired
 *  `resolved` already matches the remote snapshot emits no reconcile
 *  operation, and no step result will ever advance it — without this it
 *  stays `syncing` forever (persisted, and protected from refresh by the
 *  merge policy; issue #188). Flip it straight back to `synced`. Threads
 *  without a remoteThreadId are left alone: they may still receive one from
 *  a review-batch mapping in the same submit. */
export function completeNoopThreadSyncs(local: LocalState, remote: RemoteState): LocalState {
  let changed = false;
  const threads = local.threads.map((t) => {
    if (t.state !== "syncing" || t.remoteThreadId === undefined) return t;
    const remoteThread = remote.threads.find((r) => r.remoteThreadId === t.remoteThreadId);
    // Mirror the reconciler's comparison exactly (absent remote → false).
    const remoteResolved = remoteThread?.resolved ?? false;
    if (t.resolved !== remoteResolved) return t;
    changed = true;
    return { ...t, state: "synced" as const, lastError: undefined };
  });
  return changed ? { ...local, threads } : local;
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

/** Apply step results to RemoteState, the last-known GitHub mirror — the
 *  counterpart of applyStepResults for LocalState. Every successful step is a
 *  confirmed GitHub write, so it is reflected into the mirror per ADR 0001's
 *  lifecycle sequence ("update RemoteState" on Submit): posted comments and threads
 *  are upserted as synced, resolved toggles update the mirrored thread (the
 *  Reconciler diffs against it), and a Commit advances the head SHA (the next
 *  Commit is parented on it, and the editor reloads the new head). Failed
 *  steps changed nothing on GitHub and change nothing here. */
export function applyStepResultsToRemote(remote: RemoteState, results: StepResult[]): RemoteState {
  let next = remote;
  for (const result of results) {
    next = applyStepResultToRemote(next, result);
  }
  return next;
}

function applyStepResultToRemote(remote: RemoteState, result: StepResult): RemoteState {
  switch (result.step.kind) {
    case "post-review-batch": {
      const o = result.outcome as PostReviewBatchOutcome;
      return o.ok ? applyReviewBatchSuccessToRemote(remote, result.step, o.mappings) : remote;
    }
    case "post-reply":
    case "post-issue-comment": {
      const o = result.outcome as PostReplyOutcome | PostIssueCommentOutcome;
      if (!o.ok) return remote;
      const synced: Comment = {
        ...result.step.comment,
        state: "synced",
        remoteId: o.mapping.remoteId,
        lastError: undefined,
      };
      return { ...remote, comments: upsertRemoteComment(remote.comments, synced) };
    }
    case "resolve-review-thread":
    case "unresolve-review-thread": {
      const o = result.outcome as ResolveOutcome;
      if (!o.ok) return remote;
      const threadId = result.step.threadId;
      const resolved = result.step.kind === "resolve-review-thread";
      return {
        ...remote,
        threads: remote.threads.map((t) => (t.id === threadId ? { ...t, resolved } : t)),
      };
    }
    case "commit": {
      const o = result.outcome as CommitOutcome;
      if (!o.ok || !remote.pullRequest) return remote;
      return { ...remote, pullRequest: { ...remote.pullRequest, headSha: o.newHeadSha } };
    }
  }
}

function applyReviewBatchSuccessToRemote(
  remote: RemoteState,
  step: PostReviewBatchStep,
  mappings: CommentRemoteMapping[],
): RemoteState {
  const byCid = new Map(mappings.map((m) => [m.cid, m]));
  let comments = remote.comments;
  const threadRemotes = new Map<LocalId, string>();
  for (const c of step.comments) {
    const m = byCid.get(c.id);
    if (!m) continue;
    comments = upsertRemoteComment(comments, {
      ...c,
      state: "synced",
      remoteId: m.remoteId,
      lastError: undefined,
    });
    if (m.remoteThreadId) threadRemotes.set(c.threadId, m.remoteThreadId);
  }
  let threads = remote.threads;
  for (const [threadId, remoteThreadId] of threadRemotes) {
    threads = threads.some((t) => t.id === threadId)
      ? threads.map((t) =>
          t.id === threadId ? { ...t, state: "synced", remoteThreadId, lastError: undefined } : t,
        )
      : // A thread just created on GitHub starts unresolved.
        [...threads, { id: threadId, state: "synced", resolved: false, remoteThreadId }];
  }
  return { ...remote, comments, threads };
}

function upsertRemoteComment(comments: Comment[], next: Comment): Comment[] {
  const idx = comments.findIndex((c) => c.id === next.id);
  if (idx === -1) return [...comments, next];
  const out = comments.slice();
  out[idx] = next;
  return out;
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
