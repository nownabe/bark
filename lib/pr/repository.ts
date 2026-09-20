// PullRequestRepository — the umbrella per-PR component.
//
// Owns LocalState (persistent) and RemoteState (in-memory), exposes mutation
// methods, runs the reconcile/plan/execute pipeline on submit, and applies
// step results back to LocalState per the state machine.
//
// React subscribes via `subscribe(listener)` and reads via `getLocalState()`
// / `getRemoteState()`. The AppState derivation layer (Phase 4) sits on top.
//
// See docs/adr/0001-pr-data-layer-architecture.md §2.

import { execute } from "./executor";
import { planExecution, type PlannerContext } from "./planner";
import { reconcile } from "./reconciler";
import {
  applyStepResults,
  applyStepResultsToRemote,
  completeNoopThreadSyncs,
  deferredSyncError,
  flipDraftsToSyncing,
  mergeRemoteIntoLocal,
  revertOrphanedSyncing,
  setThreadResolvedToSyncing,
} from "./state-machine";
import type { StorageAdapter } from "./storage";
import type { Transport } from "./transport";
import type { Comment, FileEdit, LocalId, LocalState, RemoteState, Thread } from "./types";
import { emptyState, hasRemoteIdentity } from "./types";

export type RepositoryOptions = {
  storage: StorageAdapter;
  transport: Transport;
  /** Routes a Comment to PostReviewBatch (in-diff) or PostIssueComment (out-of-diff). */
  isInDiff: (comment: Comment) => boolean;
  /** Cap on chained reconcile cycles within one sync invocation; the only
   *  case that needs more than one is reply chains where the parent must
   *  sync first. Default 5. */
  maxSyncCycles?: number;
  /** Reports a failed persist; the mutation itself still succeeds. */
  onPersistError?: (error: unknown) => void;
};

export class PullRequestRepository {
  private localState: LocalState = emptyState();
  private remoteState: RemoteState = emptyState();
  private readonly listeners = new Set<() => void>();
  private readonly storage: StorageAdapter;
  private readonly transport: Transport;
  private readonly isInDiff: (comment: Comment) => boolean;
  private readonly maxSyncCycles: number;
  private readonly onPersistError?: (error: unknown) => void;

  constructor(opts: RepositoryOptions) {
    this.storage = opts.storage;
    this.transport = opts.transport;
    this.isInDiff = opts.isInDiff;
    this.maxSyncCycles = opts.maxSyncCycles ?? 5;
    this.onPersistError = opts.onPersistError;
  }

  // ---- Hydration / lifecycle ---------------------------------------------

  /** Load persisted LocalState from storage. Call once at startup. */
  async hydrate(): Promise<void> {
    const loaded = await this.storage.load();
    if (loaded) {
      this.localState = revertOrphanedSyncing(loaded);
      this.notify();
      if (this.localState !== loaded) await this.persist();
    }
  }

  // ---- Snapshots ---------------------------------------------------------

  getLocalState(): LocalState {
    return this.localState;
  }

  getRemoteState(): RemoteState {
    return this.remoteState;
  }

  // ---- Subscription ------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- Mutations ---------------------------------------------------------

  /** Insert or update a Comment in LocalState. The caller supplies the full
   *  Comment object including id; this is meant for both creation and edits.
   *
   *  A top-level Comment carries its Thread: if no Thread with the Comment's
   *  `threadId` exists yet, a draft one is created alongside it, so the
   *  Thread can receive the remote identity the submit returns and be
   *  resolved in the same session (issue #272). Replies never create one. */
  async upsertComment(comment: Comment): Promise<void> {
    const threads = this.localState.threads;
    const needsThread =
      comment.parentLocalId === undefined && !threads.some((t) => t.id === comment.threadId);
    this.localState = {
      ...this.localState,
      comments: upsertById(this.localState.comments, comment),
      threads: needsThread
        ? [...threads, { id: comment.threadId, state: "draft", resolved: false }]
        : threads,
    };
    this.notify();
    await this.persist();
  }

  async upsertThread(thread: Thread): Promise<void> {
    this.localState = {
      ...this.localState,
      threads: upsertById(this.localState.threads, thread),
    };
    this.notify();
    await this.persist();
  }

  async upsertFileEdit(fileEdit: FileEdit): Promise<void> {
    this.localState = {
      ...this.localState,
      fileEdits: upsertById(this.localState.fileEdits, fileEdit),
    };
    this.notify();
    await this.persist();
  }

  /** Remove a Comment and everything that hangs off it: its replies, and
   *  their replies (a reply has no home once its parent is gone, issue
   *  #271). A Thread left with no Comments and no remote identity is a draft
   *  thread with nothing in it, so it goes too (issue #272). */
  async discardComment(id: LocalId): Promise<void> {
    const discarded = new Set([id]);
    // Iterating a Set visits entries added during the loop, so this walks the
    // whole reply tree without a separate worklist.
    for (const parentId of discarded) {
      for (const c of this.localState.comments) {
        if (c.parentLocalId === parentId) discarded.add(c.id);
      }
    }
    const comments = this.localState.comments.filter((c) => !discarded.has(c.id));
    this.localState = {
      ...this.localState,
      comments,
      threads: this.localState.threads.filter(
        (t) => hasRemoteIdentity(t) || comments.some((c) => c.threadId === t.id),
      ),
    };
    this.notify();
    await this.persist();
  }

  async discardFileEdit(id: LocalId): Promise<void> {
    this.localState = {
      ...this.localState,
      fileEdits: this.localState.fileEdits.filter((f) => f.id !== id),
    };
    this.notify();
    await this.persist();
  }

  // ---- Pipeline triggers -------------------------------------------------

  /** Flip every draft Comment/Thread/FileEdit to syncing and run the
   *  reconcile → plan → execute → apply cycle. */
  async submitDrafts(): Promise<void> {
    this.localState = flipDraftsToSyncing(this.localState);
    this.notify();
    await this.persist();
    await this.runSyncCycles();
  }

  /** Toggle a Thread's resolved field. For a synced Thread this also flips
   *  it to syncing and runs the pipeline (immediate-action UX). */
  async setThreadResolved(id: LocalId, resolved: boolean): Promise<void> {
    this.localState = setThreadResolvedToSyncing(this.localState, id, resolved);
    this.notify();
    await this.persist();
    await this.runSyncCycles();
  }

  // ---- Refresh -----------------------------------------------------------

  /** Replace RemoteState with a freshly-fetched snapshot and merge it into
   *  LocalState per the conflict policy.
   *
   *  Network-fetching itself is the caller's responsibility (Phase 5 wiring). */
  async setRemoteState(remote: RemoteState): Promise<void> {
    this.remoteState = remote;
    this.localState = mergeRemoteIntoLocal(this.localState, remote);
    this.notify();
    await this.persist();
  }

  // ---- Internals ---------------------------------------------------------

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  // A storage write that fails (quota, transient error) must not fail the
  // mutation: memory stays authoritative and every later mutation writes the
  // whole state again, so the next successful write catches up (ADR 0001 §2).
  private async persist(): Promise<void> {
    try {
      await this.storage.save(this.localState);
    } catch (e) {
      this.onPersistError?.(e);
    }
  }

  private plannerContext(): PlannerContext | null {
    const pr = this.remoteState.pullRequest;
    if (!pr) return null;
    return {
      isInDiff: this.isInDiff,
      headSha: pr.headSha,
      headRef: pr.headRef,
      fileContents: this.remoteState.fileContents,
      pullRequest: pr,
    };
  }

  private async runSyncCycles(): Promise<void> {
    for (let i = 0; i < this.maxSyncCycles; i++) {
      // Recompute per cycle: a successful Commit advances the head SHA and the
      // next cycle (and the next submit) must plan against it.
      const ctx = this.plannerContext();
      if (!ctx) return;
      // A syncing Thread whose desired resolved already matches remote has
      // nothing to push — the reconciler skips it, so complete it here or it
      // would stay "syncing" forever (issue #188).
      const completed = completeNoopThreadSyncs(this.localState, this.remoteState);
      if (completed !== this.localState) {
        this.localState = completed;
        this.notify();
        await this.persist();
      }
      const ops = reconcile(this.localState, this.remoteState);
      if (ops.length === 0) break;
      const steps = planExecution(ops, ctx);
      if (steps.length === 0) break;
      const results = await execute(steps, this.transport);
      // Every result lands in both stores: entity transitions in LocalState,
      // confirmed GitHub writes in the RemoteState mirror.
      this.localState = applyStepResults(this.localState, results);
      this.remoteState = applyStepResultsToRemote(this.remoteState, results);
      this.notify();
      await this.persist();
    }
    // Nothing still `syncing` here was ever carried by a step — every step
    // result lands its items. It is a reply the Reconciler kept deferring
    // because its parent never synced (issue #271).
    const swept = revertOrphanedSyncing(this.localState, deferredSyncError(this.localState));
    if (swept !== this.localState) {
      this.localState = swept;
      this.notify();
      await this.persist();
    }
  }
}

function upsertById<T extends { id: LocalId }>(items: T[], next: T): T[] {
  const idx = items.findIndex((x) => x.id === next.id);
  if (idx === -1) return [...items, next];
  const out = items.slice();
  out[idx] = next;
  return out;
}
