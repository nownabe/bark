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
import type {
  PostReviewBatchStep,
  ResolveReviewThreadStep,
  SetIssueThreadResolvedStep,
  UnresolveReviewThreadStep,
} from "./steps";
import type {
  CommentRemoteMapping,
  CommitOutcome,
  PostIssueCommentOutcome,
  PostReplyOutcome,
  PostReviewBatchOutcome,
  ResolveOutcome,
} from "./transport";
import {
  type Comment,
  type ErrorInfo,
  findRemoteThread,
  hasRemoteIdentity,
  type LocalId,
  type LocalState,
  type RemoteState,
  type Thread,
} from "./types";

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

/** Revert every `syncing` entity that no step will ever advance. For a
 *  freshly-hydrated state: no step is in flight, so nothing would ever
 *  advance them, and the UI shows neither pending nor submitted items in
 *  that state (issue #266 path C). An item that did reach GitHub is adopted
 *  back by cid on the next refresh (see mergeBy).
 *
 *  A Thread that exists on GitHub goes back to `synced`, not `draft`: a
 *  draft never carries a remote identifier (ADR 0002 §2, issue #275). The
 *  next refresh overwrites it with GitHub's value. */
export function revertOrphanedSyncing(local: LocalState): LocalState {
  const isSyncing = (x: { state: string }) => x.state === "syncing";
  if (![...local.comments, ...local.threads, ...local.fileEdits].some(isSyncing)) return local;
  const toDraft = <T extends { state: string }>(x: T): T =>
    isSyncing(x) ? { ...x, state: "draft", lastError: UNCONFIRMED_POST } : x;
  return {
    ...local,
    comments: local.comments.map(toDraft),
    threads: local.threads.map((t) =>
      isSyncing(t) && hasRemoteIdentity(t)
        ? { ...t, state: "synced", lastError: UNCONFIRMED_POST }
        : toDraft(t),
    ),
    fileEdits: local.fileEdits.map(toDraft),
  };
}

/** Set a Thread's `resolved` field. A `synced` Thread also transitions to
 *  `syncing` so the change is pushed — including the retry after a failed
 *  toggle, which parks the Thread back in `synced` with `lastError` (issue
 *  #275). A draft (not on GitHub yet) just updates the field: it syncs with
 *  the next submit. */
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

/** Complete "nothing to push" thread syncs. A `syncing` Thread whose desired
 *  `resolved` already matches the remote snapshot emits no reconcile
 *  operation, and no step result will ever advance it — without this it
 *  stays `syncing` forever (persisted, and protected from refresh by the
 *  merge policy; issue #188). Flip it straight back to `synced`. Threads
 *  with no remote identity are left alone: they may still receive one from
 *  a review-batch mapping in the same submit. */
export function completeNoopThreadSyncs(local: LocalState, remote: RemoteState): LocalState {
  let changed = false;
  const threads = local.threads.map((t) => {
    if (t.state !== "syncing" || !hasRemoteIdentity(t)) return t;
    // Mirror the reconciler's lookup and comparison exactly (absent remote → false).
    const remoteResolved = findRemoteThread(remote.threads, t)?.resolved ?? false;
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
        ? applyReviewBatchSuccess(local, result.step, o.mappings, o.confirmError)
        : applyUnpostedCommentsFailure(local, result.step.comments, o.error);
    }
    case "reject-comment":
      return applyUnpostedCommentsFailure(local, [result.step.comment], result.step.error);
    case "post-reply": {
      const o = result.outcome as PostReplyOutcome;
      return o.ok
        ? applyCommentMapping(local, o.mapping)
        : applyCommentFailure(local, result.step.comment.id, o.error);
    }
    case "post-issue-comment": {
      const o = result.outcome as PostIssueCommentOutcome;
      return o.ok
        ? applyIssueCommentMapping(local, result.step.comment, o.mapping)
        : applyCommentFailure(local, result.step.comment.id, o.error);
    }
    case "resolve-review-thread":
    case "unresolve-review-thread":
    case "set-issue-thread-resolved": {
      const o = result.outcome as ResolveOutcome;
      return o.ok
        ? applyThreadSyncSuccess(local, result.step.threadId)
        : applyThreadSyncFailure(
            local,
            result.step.threadId,
            o.error,
            desiredResolvedOf(result.step),
          );
    }
    case "commit": {
      const o = result.outcome as CommitOutcome;
      const ids = result.step.fileEdits.map((f) => f.id);
      return o.ok ? applyCommitSuccess(local, ids) : applyCommitFailure(local, ids, o.error);
    }
    case "reject-commit":
      return applyCommitFailure(
        local,
        result.step.fileEdits.map((f) => f.id),
        result.step.error,
      );
  }
}

/** Comments the identity listing did not confirm are on GitHub but have no
 *  remoteId, so they cannot stay `syncing` (nothing would ever advance them,
 *  and the UI hides that state). Revert them to draft with an error; the
 *  next refresh adopts the remote copy by cid (see mergeBy). */
const UNCONFIRMED_POST: ErrorInfo = {
  message: "Posted to GitHub, but the new comment could not be confirmed yet. Refresh to sync.",
};

function applyReviewBatchSuccess(
  local: LocalState,
  step: PostReviewBatchStep,
  mappings: CommentRemoteMapping[],
  confirmError?: ErrorInfo,
): LocalState {
  const byCid = new Map(mappings.map((m) => [m.cid, m]));
  const threadRemotes = new Map<LocalId, string>();
  for (const m of mappings) {
    if (m.remoteThreadId) {
      const c = step.comments.find((x) => x.id === m.cid);
      if (c) threadRemotes.set(c.threadId, m.remoteThreadId);
    }
  }
  const unconfirmed = step.comments.filter((c) => !byCid.has(c.id));
  if (unconfirmed.length > 0) {
    local = applyUnpostedCommentsFailure(local, unconfirmed, confirmError ?? UNCONFIRMED_POST);
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

/** Comments that never landed on GitHub go back to draft, together with the
 *  Threads they were meant to create (a Thread that already exists remotely
 *  keeps its state). */
function applyUnpostedCommentsFailure(
  local: LocalState,
  comments: Comment[],
  error: ErrorInfo,
): LocalState {
  const commentIds = new Set(comments.map((c) => c.id));
  const threadIds = new Set(comments.map((c) => c.threadId));
  return {
    ...local,
    comments: local.comments.map((c) =>
      commentIds.has(c.id) ? { ...c, state: "draft", lastError: error } : c,
    ),
    threads: local.threads.map((t) =>
      threadIds.has(t.id) && t.state === "syncing" && !hasRemoteIdentity(t)
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

/** A posted top-level issue comment is its thread's root, so its REST id is
 *  the thread's remote identity (ADR 0003 §7). Filling it here is what makes
 *  a just-created out-of-diff thread resolvable without a refresh (#272). */
function applyIssueCommentMapping(
  local: LocalState,
  comment: Comment,
  m: CommentRemoteMapping,
): LocalState {
  const next = applyCommentMapping(local, m);
  if (comment.parentLocalId !== undefined) return next;
  return {
    ...next,
    threads: next.threads.map((t) =>
      t.id === comment.threadId && t.state === "syncing" && !hasRemoteIdentity(t)
        ? { ...t, state: "synced", remoteIssueCommentId: m.remoteId, lastError: undefined }
        : t,
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

type ResolveStep = ResolveReviewThreadStep | UnresolveReviewThreadStep | SetIssueThreadResolvedStep;

/** The `resolved` value a resolve step is trying to write. */
function desiredResolvedOf(step: ResolveStep): boolean {
  return step.kind === "set-issue-thread-resolved"
    ? step.resolved
    : step.kind === "resolve-review-thread";
}

/** A failed toggle on an already-synced Thread returns to `synced` with the
 *  field rolled back to the remote value — a draft never carries a remote
 *  identifier (ADR 0001 §3, issue #275). The Reconciler emits the step only
 *  when local differs from remote, so the remote value is `!desired`. */
function applyThreadSyncFailure(
  local: LocalState,
  threadId: LocalId,
  error: ErrorInfo,
  desired: boolean,
): LocalState {
  return {
    ...local,
    threads: local.threads.map((t) =>
      t.id === threadId ? { ...t, state: "synced", resolved: !desired, lastError: error } : t,
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
    case "reject-comment":
    case "reject-commit":
      return remote;
    case "post-reply":
    case "post-issue-comment": {
      const o = result.outcome as PostReplyOutcome | PostIssueCommentOutcome;
      if (!o.ok) return remote;
      const comment = result.step.comment;
      const synced: Comment = {
        ...comment,
        state: "synced",
        remoteId: o.mapping.remoteId,
        lastError: undefined,
      };
      const next = { ...remote, comments: upsertRemoteComment(remote.comments, synced) };
      if (result.step.kind === "post-reply" || comment.parentLocalId !== undefined) return next;
      return {
        ...next,
        threads: upsertRemoteThread(next.threads, comment.threadId, {
          remoteIssueCommentId: o.mapping.remoteId,
        }),
      };
    }
    case "resolve-review-thread":
    case "unresolve-review-thread":
    case "set-issue-thread-resolved": {
      const o = result.outcome as ResolveOutcome;
      if (!o.ok) return remote;
      const threadId = result.step.threadId;
      const resolved = desiredResolvedOf(result.step);
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
    threads = upsertRemoteThread(threads, threadId, { remoteThreadId });
  }
  return { ...remote, comments, threads };
}

/** Record a thread GitHub just created in the mirror: merge the identity into
 *  the existing entry, or add it as synced and unresolved. */
function upsertRemoteThread(
  threads: Thread[],
  id: LocalId,
  identity: Pick<Thread, "remoteThreadId" | "remoteIssueCommentId">,
): Thread[] {
  return threads.some((t) => t.id === id)
    ? threads.map((t) =>
        t.id === id ? { ...t, ...identity, state: "synced", lastError: undefined } : t,
      )
    : [...threads, { id, state: "synced", resolved: false, ...identity }];
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
    (c) => c.remoteId === undefined,
  );
  const newThreads = mergeBy<Thread>(
    local.threads,
    remote.threads,
    (t) => t.state === "draft" || t.state === "syncing",
    (t) => !hasRemoteIdentity(t),
  );
  return {
    ...local,
    comments: newComments,
    threads: newThreads,
  };
}

/** Protected (draft/syncing) local items win over remote — except when the
 *  local item has no remote identity yet and remote carries the same id:
 *  that id was minted locally, so the item did reach GitHub and the local
 *  copy just never learned it (unconfirmed post or crash mid-sync, issue
 *  #266). Adopt the remote copy; otherwise the next submit posts it again. */
function mergeBy<T extends { id: LocalId }>(
  localItems: T[],
  remoteItems: T[],
  isProtected: (item: T) => boolean,
  lacksRemoteIdentity: (item: T) => boolean,
): T[] {
  const remoteById = new Map(remoteItems.map((x) => [x.id, x]));
  const localById = new Map(localItems.map((x) => [x.id, x]));
  const result: T[] = [];
  for (const x of localItems) {
    if (isProtected(x) && !(lacksRemoteIdentity(x) && remoteById.has(x.id))) result.push(x);
    // synced local items: drop here, the remote version (if any) is added below
  }
  for (const r of remoteItems) {
    const local = localById.get(r.id);
    if (!local || !isProtected(local) || lacksRemoteIdentity(local)) {
      result.push(r);
    }
  }
  return result;
}
