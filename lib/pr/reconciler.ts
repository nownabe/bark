// PullRequestReconciler — pure function turning (LocalState, RemoteState)
// into a flat list of ReconcileOperations.
// See docs/adr/0003-operations-and-execution.md §2 for the emit rules.

import type { ReconcileOperation } from "./operations";
import type { LocalState, RemoteState, Thread } from "./types";

export function reconcile(local: LocalState, remote: RemoteState): ReconcileOperation[] {
  const ops: ReconcileOperation[] = [];

  // Comments
  for (const c of local.comments) {
    if (c.state !== "syncing") continue;
    if (c.remoteId !== undefined) continue; // already has a remote identity

    if (c.parentLocalId === undefined) {
      ops.push({ kind: "create-comment", comment: c });
      continue;
    }

    const parent = local.comments.find((p) => p.id === c.parentLocalId);
    if (parent && parent.state === "synced") {
      ops.push({ kind: "create-reply", comment: c, parent });
    }
    // else: defer — parent not yet synced (or missing). Will be re-evaluated
    // on the next reconcile cycle once the parent lands.
  }

  // Threads
  for (const t of local.threads) {
    if (t.state !== "syncing") continue;
    if (t.remoteThreadId === undefined) continue; // thread not yet created on GitHub

    const remoteThread = findRemoteThreadByRemoteId(remote.threads, t.remoteThreadId);
    const remoteResolved = remoteThread?.resolved ?? false;

    if (t.resolved !== remoteResolved) {
      ops.push({
        kind: "update-thread-resolved",
        threadId: t.id,
        desiredResolved: t.resolved,
      });
    }
  }

  // FileEdits
  for (const f of local.fileEdits) {
    if (f.state !== "syncing") continue;
    ops.push({ kind: "commit-file-edit", fileEdit: f });
  }

  return ops;
}

function findRemoteThreadByRemoteId(threads: Thread[], remoteThreadId: string): Thread | undefined {
  return threads.find((t) => t.remoteThreadId === remoteThreadId);
}
