import { describe, expect, test } from "bun:test";
import { reconcile } from "../../lib/pr/reconciler";
import type { Comment, FileEdit, LocalState, RemoteState, Thread } from "../../lib/pr/types";
import { emptyState } from "../../lib/pr/types";

const author = { login: "alice" };
const anchor = {
  sha: "deadbeef",
  range: { sl: 1, sc: 1, el: 1, ec: 10 },
  quote: "hello",
};

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    state: "syncing",
    threadId: "t1",
    body: "body",
    author,
    path: "README.md",
    anchor,
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    state: "synced",
    resolved: false,
    ...overrides,
  };
}

function fileEdit(overrides: Partial<FileEdit> = {}): FileEdit {
  return {
    id: "f1",
    state: "syncing",
    path: "README.md",
    baseSha: "deadbeef",
    editedSource: "edited content",
    ...overrides,
  };
}

function localState(overrides: Partial<LocalState> = {}): LocalState {
  return { ...emptyState(), ...overrides };
}

function remoteState(overrides: Partial<RemoteState> = {}): RemoteState {
  return { ...emptyState(), ...overrides };
}

describe("reconciler — empty / inert cases", () => {
  test("empty states emit no operations", () => {
    expect(reconcile(emptyState(), emptyState())).toEqual([]);
  });

  test("a draft Comment is invisible to the Reconciler", () => {
    const c = comment({ state: "draft" });
    expect(reconcile(localState({ comments: [c] }), emptyState())).toEqual([]);
  });

  test("a synced Comment emits nothing", () => {
    const c = comment({ state: "synced", remoteId: 42 });
    expect(reconcile(localState({ comments: [c] }), emptyState())).toEqual([]);
  });

  test("a syncing Comment that already has a remoteId emits nothing (defensive)", () => {
    const c = comment({ state: "syncing", remoteId: 42 });
    expect(reconcile(localState({ comments: [c] }), emptyState())).toEqual([]);
  });
});

describe("reconciler — CreateComment", () => {
  test("a top-level syncing Comment without remoteId emits CreateComment", () => {
    const c = comment();
    const ops = reconcile(localState({ comments: [c] }), emptyState());
    expect(ops).toEqual([{ kind: "create-comment", comment: c }]);
  });

  test("multiple top-level syncing Comments emit a CreateComment each", () => {
    const c1 = comment({ id: "c1", threadId: "t1" });
    const c2 = comment({ id: "c2", threadId: "t2" });
    const ops = reconcile(localState({ comments: [c1, c2] }), emptyState());
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ kind: "create-comment", comment: c1 });
    expect(ops[1]).toEqual({ kind: "create-comment", comment: c2 });
  });
});

describe("reconciler — CreateReply", () => {
  test("a syncing reply whose parent is synced emits CreateReply", () => {
    const parent = comment({ id: "c-parent", state: "synced", remoteId: 101 });
    const reply = comment({
      id: "c-reply",
      state: "syncing",
      parentLocalId: "c-parent",
    });
    const ops = reconcile(localState({ comments: [parent, reply] }), emptyState());
    expect(ops).toEqual([{ kind: "create-reply", comment: reply, parent }]);
  });

  test("a syncing reply whose parent is still draft emits no Op this cycle", () => {
    const parent = comment({ id: "c-parent", state: "draft" });
    const reply = comment({
      id: "c-reply",
      state: "syncing",
      parentLocalId: "c-parent",
    });
    const ops = reconcile(localState({ comments: [parent, reply] }), emptyState());
    expect(ops).toEqual([]);
  });

  test("a syncing reply whose parent is still syncing emits no Op this cycle", () => {
    const parent = comment({ id: "c-parent", state: "syncing" });
    const reply = comment({
      id: "c-reply",
      state: "syncing",
      parentLocalId: "c-parent",
    });
    const ops = reconcile(localState({ comments: [parent, reply] }), emptyState());
    // The parent itself is a CreateComment; the reply is deferred.
    expect(ops).toEqual([{ kind: "create-comment", comment: parent }]);
  });

  test("a syncing reply whose parent does not exist in LocalState emits no Op (defensive)", () => {
    const reply = comment({
      id: "c-reply",
      state: "syncing",
      parentLocalId: "missing-parent",
    });
    expect(reconcile(localState({ comments: [reply] }), emptyState())).toEqual([]);
  });
});

describe("reconciler — UpdateThreadResolved", () => {
  test("a syncing Thread that has no remoteThreadId emits no Op (cannot resolve a not-yet-created thread)", () => {
    const t = thread({ state: "syncing", resolved: true });
    expect(reconcile(localState({ threads: [t] }), emptyState())).toEqual([]);
  });

  test("a syncing Thread whose resolved differs from remote emits UpdateThreadResolved", () => {
    const t = thread({
      state: "syncing",
      remoteThreadId: "PRT_remote1",
      resolved: true,
    });
    const remoteT = thread({
      state: "synced",
      remoteThreadId: "PRT_remote1",
      resolved: false,
    });
    const ops = reconcile(localState({ threads: [t] }), remoteState({ threads: [remoteT] }));
    expect(ops).toEqual([
      {
        kind: "update-thread-resolved",
        threadId: "t1",
        remoteThreadId: "PRT_remote1",
        desiredResolved: true,
      },
    ]);
  });

  test("a syncing Thread whose resolved matches remote emits no Op", () => {
    const t = thread({
      state: "syncing",
      remoteThreadId: "PRT_remote1",
      resolved: true,
    });
    const remoteT = thread({
      state: "synced",
      remoteThreadId: "PRT_remote1",
      resolved: true,
    });
    expect(reconcile(localState({ threads: [t] }), remoteState({ threads: [remoteT] }))).toEqual(
      [],
    );
  });

  test("a draft Thread is invisible", () => {
    const t = thread({
      state: "draft",
      remoteThreadId: "PRT_remote1",
      resolved: true,
    });
    const remoteT = thread({
      state: "synced",
      remoteThreadId: "PRT_remote1",
      resolved: false,
    });
    expect(reconcile(localState({ threads: [t] }), remoteState({ threads: [remoteT] }))).toEqual(
      [],
    );
  });

  test("matching remote thread is found by remoteThreadId, not by id", () => {
    // LocalState.id and RemoteState.id may differ; the bridge is remoteThreadId.
    const local = thread({
      id: "t1",
      state: "syncing",
      remoteThreadId: "PRT_remote_xyz",
      resolved: true,
    });
    const remote = thread({
      id: "t-different",
      state: "synced",
      remoteThreadId: "PRT_remote_xyz",
      resolved: false,
    });
    const ops = reconcile(localState({ threads: [local] }), remoteState({ threads: [remote] }));
    expect(ops).toEqual([
      {
        kind: "update-thread-resolved",
        threadId: "t1",
        remoteThreadId: "PRT_remote_xyz",
        desiredResolved: true,
      },
    ]);
  });
});

describe("reconciler — CommitFileEdit", () => {
  test("a syncing FileEdit emits CommitFileEdit", () => {
    const fe = fileEdit();
    const ops = reconcile(localState({ fileEdits: [fe] }), emptyState());
    expect(ops).toEqual([{ kind: "commit-file-edit", fileEdit: fe }]);
  });

  test("a draft FileEdit is invisible", () => {
    const fe = fileEdit({ state: "draft" });
    expect(reconcile(localState({ fileEdits: [fe] }), emptyState())).toEqual([]);
  });

  test("multiple syncing FileEdits emit a CommitFileEdit each", () => {
    const fe1 = fileEdit({ id: "f1", path: "a.md" });
    const fe2 = fileEdit({ id: "f2", path: "b.md" });
    const ops = reconcile(localState({ fileEdits: [fe1, fe2] }), emptyState());
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ kind: "commit-file-edit", fileEdit: fe1 });
    expect(ops[1]).toEqual({ kind: "commit-file-edit", fileEdit: fe2 });
  });
});

describe("reconciler — mixed cases", () => {
  test("Comments, Threads, and FileEdits can emit Ops in the same cycle", () => {
    const c = comment();
    const t = thread({
      state: "syncing",
      remoteThreadId: "PRT_r",
      resolved: true,
    });
    const remoteT = thread({
      state: "synced",
      remoteThreadId: "PRT_r",
      resolved: false,
    });
    const fe = fileEdit();
    const ops = reconcile(
      localState({ comments: [c], threads: [t], fileEdits: [fe] }),
      remoteState({ threads: [remoteT] }),
    );
    expect(ops).toHaveLength(3);
    expect(ops).toContainEqual({ kind: "create-comment", comment: c });
    expect(ops).toContainEqual({
      kind: "update-thread-resolved",
      threadId: "t1",
      remoteThreadId: "PRT_r",
      desiredResolved: true,
    });
    expect(ops).toContainEqual({ kind: "commit-file-edit", fileEdit: fe });
  });

  test("Reconciler does not mutate the input states", () => {
    const c = comment();
    const local = localState({ comments: [c] });
    const remote = emptyState();
    const localCopy = JSON.parse(JSON.stringify(local));
    const remoteCopy = JSON.parse(JSON.stringify(remote));
    reconcile(local, remote);
    expect(local).toEqual(localCopy);
    expect(remote).toEqual(remoteCopy);
  });
});
