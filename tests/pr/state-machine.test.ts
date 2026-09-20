import { describe, expect, test } from "bun:test";
import type { StepResult } from "../../lib/pr/executor";
import type { CommitOutcome } from "../../lib/pr/transport";
import {
  applyStepResults,
  applyStepResultsToRemote,
  completeNoopThreadSyncs,
  flipDraftsToSyncing,
  mergeRemoteIntoLocal,
  revertOrphanedSyncing,
  setThreadResolvedToSyncing,
} from "../../lib/pr/state-machine";
import type {
  Comment,
  FileEdit,
  LocalState,
  PullRequest,
  RemoteState,
  Thread,
} from "../../lib/pr/types";
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
    editedSource: "edited",
    ...overrides,
  };
}

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    owner: "o",
    repo: "r",
    number: 1,
    title: "t",
    body: "b",
    headSha: "h",
    headRef: "topic",
    baseRef: "main",
    state: "open",
    draft: false,
    merged: false,
    author,
    ...overrides,
  };
}

function localState(overrides: Partial<LocalState> = {}): LocalState {
  return { ...emptyState(), ...overrides };
}

function remoteState(overrides: Partial<RemoteState> = {}): RemoteState {
  return { ...emptyState(), ...overrides };
}

describe("state-machine — flipDraftsToSyncing", () => {
  test("flips draft Comments, Threads, and FileEdits to syncing", () => {
    const dc = comment({ id: "dc", state: "draft" });
    const sc = comment({ id: "sc", state: "synced", remoteId: 1 });
    const dt = thread({ id: "dt", state: "draft" });
    const st = thread({ id: "st", state: "synced", remoteThreadId: "PRT" });
    const df = fileEdit({ id: "df", state: "draft" });
    const sf = fileEdit({ id: "sf", state: "syncing" });

    const out = flipDraftsToSyncing(
      localState({ comments: [dc, sc], threads: [dt, st], fileEdits: [df, sf] }),
    );
    expect(out.comments.find((c) => c.id === "dc")?.state).toBe("syncing");
    expect(out.comments.find((c) => c.id === "sc")?.state).toBe("synced");
    expect(out.threads.find((t) => t.id === "dt")?.state).toBe("syncing");
    expect(out.threads.find((t) => t.id === "st")?.state).toBe("synced");
    expect(out.fileEdits.find((f) => f.id === "df")?.state).toBe("syncing");
    expect(out.fileEdits.find((f) => f.id === "sf")?.state).toBe("syncing");
  });

  test("clears lastError on the flipped entities", () => {
    const c = comment({
      state: "draft",
      lastError: { message: "old failure" },
    });
    const out = flipDraftsToSyncing(localState({ comments: [c] }));
    expect(out.comments[0]?.lastError).toBeUndefined();
  });
});

describe("state-machine — setThreadResolvedToSyncing", () => {
  test("a synced Thread transitions to syncing with the new resolved value", () => {
    const t = thread({ state: "synced", remoteThreadId: "PRT" });
    const out = setThreadResolvedToSyncing(localState({ threads: [t] }), "t1", true);
    expect(out.threads[0]).toMatchObject({ state: "syncing", resolved: true });
  });

  test("a draft Thread keeps its draft state but updates the field", () => {
    const t = thread({ state: "draft", resolved: false });
    const out = setThreadResolvedToSyncing(localState({ threads: [t] }), "t1", true);
    expect(out.threads[0]).toMatchObject({ state: "draft", resolved: true });
  });

  test("a synced Thread carrying lastError re-enters syncing on retry and clears the error (issue #275)", () => {
    // A failed resolve parks the Thread as synced+lastError, so the retry
    // click is the ordinary synced edge.
    const t = thread({ state: "synced", remoteThreadId: "PRT", lastError: { message: "boom" } });
    const out = setThreadResolvedToSyncing(localState({ threads: [t] }), "t1", true);
    expect(out.threads[0]).toMatchObject({
      state: "syncing",
      resolved: true,
      lastError: undefined,
    });
  });

  test("a non-matching id is a no-op", () => {
    const t = thread();
    const local = localState({ threads: [t] });
    expect(setThreadResolvedToSyncing(local, "other", true)).toEqual(local);
  });
});

describe("state-machine — revertOrphanedSyncing", () => {
  test("a syncing Thread with a remote identity reverts to synced, one without reverts to draft (issue #275)", () => {
    const out = revertOrphanedSyncing(
      localState({
        threads: [
          thread({ id: "a", state: "syncing", remoteThreadId: "PRT" }),
          thread({ id: "b", state: "syncing" }),
        ],
      }),
    );
    expect(out.threads[0]).toMatchObject({ id: "a", state: "synced" });
    expect(out.threads[1]).toMatchObject({ id: "b", state: "draft" });
    expect(out.threads[0]?.lastError).toBeDefined();
    expect(out.threads[1]?.lastError).toBeDefined();
  });

  test("syncing Comments and FileEdits always revert to draft", () => {
    const out = revertOrphanedSyncing(
      localState({
        comments: [comment({ state: "syncing", remoteId: 1 })],
        fileEdits: [fileEdit({ state: "syncing" })],
      }),
    );
    expect(out.comments[0]?.state).toBe("draft");
    expect(out.fileEdits[0]?.state).toBe("draft");
  });
});

describe("state-machine — completeNoopThreadSyncs (issue #188)", () => {
  test("a syncing Thread whose resolved matches remote flips back to synced", () => {
    const t = thread({ state: "syncing", remoteThreadId: "PRT", resolved: false });
    const remote = remoteState({
      threads: [thread({ state: "synced", remoteThreadId: "PRT", resolved: false })],
    });
    const out = completeNoopThreadSyncs(localState({ threads: [t] }), remote);
    expect(out.threads[0]).toMatchObject({ state: "synced", resolved: false });
  });

  test("a syncing Thread whose resolved differs from remote is left for the reconciler", () => {
    const t = thread({ state: "syncing", remoteThreadId: "PRT", resolved: true });
    const remote = remoteState({
      threads: [thread({ state: "synced", remoteThreadId: "PRT", resolved: false })],
    });
    const local = localState({ threads: [t] });
    expect(completeNoopThreadSyncs(local, remote)).toBe(local);
  });

  test("a syncing Thread without a remoteThreadId is left alone (may map in this submit)", () => {
    const t = thread({ state: "syncing", resolved: false });
    const local = localState({ threads: [t] });
    expect(completeNoopThreadSyncs(local, remoteState())).toBe(local);
  });

  test("mirrors the reconciler: an absent remote thread counts as resolved=false", () => {
    const t = thread({ state: "syncing", remoteThreadId: "PRT_gone", resolved: false });
    const out = completeNoopThreadSyncs(localState({ threads: [t] }), remoteState());
    expect(out.threads[0]?.state).toBe("synced");
  });

  test("an out-of-diff Thread whose resolved already matches remote completes, matched by id (issue #270)", () => {
    const t = thread({ id: "t-out", state: "syncing", remoteIssueCommentId: 501, resolved: true });
    const remote = remoteState({
      threads: [
        thread({ id: "t-out", state: "synced", remoteIssueCommentId: 501, resolved: true }),
      ],
    });
    const out = completeNoopThreadSyncs(localState({ threads: [t] }), remote);
    expect(out.threads[0]).toMatchObject({ state: "synced", resolved: true });
  });
});

describe("state-machine — applyStepResults: PostReviewBatch", () => {
  test("success marks each Comment synced + populates remoteId", () => {
    const c1 = comment({ id: "c1", state: "syncing" });
    const c2 = comment({ id: "c2", state: "syncing", threadId: "t2" });
    const local = localState({ comments: [c1, c2] });
    const results: StepResult[] = [
      {
        step: {
          kind: "post-review-batch",
          commitId: "h",
          comments: [c1, c2],
        },
        outcome: {
          ok: true,
          mappings: [
            { cid: "c1", remoteId: 11 },
            { cid: "c2", remoteId: 22 },
          ],
        },
      },
    ];
    const out = applyStepResults(local, results);
    expect(out.comments[0]).toMatchObject({ state: "synced", remoteId: 11 });
    expect(out.comments[1]).toMatchObject({ state: "synced", remoteId: 22 });
  });

  test("success with remoteThreadId in a mapping marks the matching Thread synced", () => {
    const c = comment({ id: "c1", state: "syncing", threadId: "t1" });
    const t = thread({ id: "t1", state: "syncing" });
    const results: StepResult[] = [
      {
        step: { kind: "post-review-batch", commitId: "h", comments: [c] },
        outcome: {
          ok: true,
          mappings: [{ cid: "c1", remoteId: 99, remoteThreadId: "PRT_new" }],
        },
      },
    ];
    const out = applyStepResults(localState({ comments: [c], threads: [t] }), results);
    expect(out.threads[0]).toMatchObject({
      state: "synced",
      remoteThreadId: "PRT_new",
    });
  });

  test("success with a missing mapping reverts that Comment (and its new Thread) to draft + lastError instead of leaving it syncing (issue #266 path A)", () => {
    const c1 = comment({ id: "c1", state: "syncing", threadId: "t1" });
    const c2 = comment({ id: "c2", state: "syncing", threadId: "t2" });
    const t2 = thread({ id: "t2", state: "syncing" });
    const results: StepResult[] = [
      {
        step: { kind: "post-review-batch", commitId: "h", comments: [c1, c2] },
        // Read-after-write lag: the identity listing did not contain c2 yet.
        outcome: { ok: true, mappings: [{ cid: "c1", remoteId: 11 }] },
      },
    ];
    const out = applyStepResults(localState({ comments: [c1, c2], threads: [t2] }), results);
    expect(out.comments[0]).toMatchObject({ state: "synced", remoteId: 11 });
    expect(out.comments[1]?.state).toBe("draft");
    expect(out.comments[1]?.lastError?.message).toBeString();
    expect(out.threads[0]?.state).toBe("draft");
  });

  test("success with confirmError surfaces it as lastError on the unmapped Comments (issue #266 path B)", () => {
    const c = comment({ id: "c1", state: "syncing" });
    const confirmError = { message: "listing failed after post" };
    const results: StepResult[] = [
      {
        step: { kind: "post-review-batch", commitId: "h", comments: [c] },
        outcome: { ok: true, mappings: [], confirmError },
      },
    ];
    const out = applyStepResults(localState({ comments: [c] }), results);
    expect(out.comments[0]).toMatchObject({ state: "draft", lastError: confirmError });
  });

  test("failure reverts every batched Comment to draft + lastError", () => {
    const c1 = comment({ id: "c1", state: "syncing" });
    const c2 = comment({ id: "c2", state: "syncing", threadId: "t2" });
    const err = { message: "422" };
    const results: StepResult[] = [
      {
        step: { kind: "post-review-batch", commitId: "h", comments: [c1, c2] },
        outcome: { ok: false, error: err },
      },
    ];
    const out = applyStepResults(localState({ comments: [c1, c2] }), results);
    expect(out.comments[0]).toMatchObject({ state: "draft", lastError: err });
    expect(out.comments[1]).toMatchObject({ state: "draft", lastError: err });
  });

  test("failure also reverts newly-created threads (syncing + no remoteThreadId) to draft", () => {
    const c = comment({ id: "c1", state: "syncing", threadId: "t1" });
    const t = thread({ id: "t1", state: "syncing" }); // no remoteThreadId
    const err = { message: "boom" };
    const results: StepResult[] = [
      {
        step: { kind: "post-review-batch", commitId: "h", comments: [c] },
        outcome: { ok: false, error: err },
      },
    ];
    const out = applyStepResults(localState({ comments: [c], threads: [t] }), results);
    expect(out.threads[0]).toMatchObject({ state: "draft", lastError: err });
  });

  test("failure does not revert an existing-thread reply scenario (thread already has remoteThreadId)", () => {
    // The comment was a reply; the thread already existed and is synced.
    const c = comment({ id: "c1", state: "syncing", threadId: "t1", parentLocalId: "p" });
    const t = thread({ id: "t1", state: "synced", remoteThreadId: "PRT_existing" });
    const results: StepResult[] = [
      {
        step: { kind: "post-review-batch", commitId: "h", comments: [c] },
        outcome: { ok: false, error: { message: "boom" } },
      },
    ];
    const out = applyStepResults(localState({ comments: [c], threads: [t] }), results);
    expect(out.threads[0]).toEqual(t); // thread unchanged
  });
});

describe("state-machine — applyStepResults: PostReply / PostIssueComment", () => {
  test("PostReply success marks the single comment synced", () => {
    const r = comment({ id: "r", state: "syncing", parentLocalId: "p" });
    const parent = comment({ id: "p", state: "synced", remoteId: 1 });
    const results: StepResult[] = [
      {
        step: { kind: "post-reply", comment: r, parent },
        outcome: { ok: true, mapping: { cid: "r", remoteId: 42 } },
      },
    ];
    const out = applyStepResults(localState({ comments: [parent, r] }), results);
    expect(out.comments.find((c) => c.id === "r")).toMatchObject({
      state: "synced",
      remoteId: 42,
    });
  });

  test("PostIssueComment success marks the comment synced", () => {
    const c = comment({ id: "x", state: "syncing" });
    const results: StepResult[] = [
      {
        step: { kind: "post-issue-comment", comment: c },
        outcome: { ok: true, mapping: { cid: "x", remoteId: 7 } },
      },
    ];
    const out = applyStepResults(localState({ comments: [c] }), results);
    expect(out.comments[0]).toMatchObject({ state: "synced", remoteId: 7 });
  });

  test("post-issue-comment success on a top-level comment marks its Thread synced with remoteIssueCommentId (issue #272)", () => {
    const c = comment({ state: "syncing" });
    const t = thread({ state: "syncing" });
    const results: StepResult[] = [
      {
        step: { kind: "post-issue-comment", comment: c },
        outcome: { ok: true, mapping: { cid: "c1", remoteId: 777 } },
      },
    ];
    const out = applyStepResults(localState({ comments: [c], threads: [t] }), results);
    expect(out.threads[0]).toEqual({
      id: "t1",
      state: "synced",
      resolved: false,
      remoteIssueCommentId: 777,
      lastError: undefined,
    });
  });

  test("post-issue-comment success on a reply leaves the Thread untouched", () => {
    const c = comment({ id: "c2", state: "syncing", parentLocalId: "c0" });
    const t = thread({ state: "synced", remoteIssueCommentId: 5 });
    const out = applyStepResults(localState({ comments: [c], threads: [t] }), [
      {
        step: { kind: "post-issue-comment", comment: c },
        outcome: { ok: true, mapping: { cid: "c2", remoteId: 777 } },
      },
    ]);
    expect(out.threads[0]).toEqual(t);
  });

  test("Failure reverts the single comment to draft + lastError", () => {
    const c = comment({ id: "x", state: "syncing" });
    const err = { message: "no" };
    const results: StepResult[] = [
      {
        step: { kind: "post-issue-comment", comment: c },
        outcome: { ok: false, error: err },
      },
    ];
    const out = applyStepResults(localState({ comments: [c] }), results);
    expect(out.comments[0]).toMatchObject({ state: "draft", lastError: err });
  });
});

describe("state-machine — applyStepResults: Resolve / Unresolve", () => {
  test("ResolveReviewThread success marks the Thread synced", () => {
    const t = thread({ state: "syncing", resolved: true, remoteThreadId: "PRT" });
    const results: StepResult[] = [
      {
        step: { kind: "resolve-review-thread", threadId: "t1", remoteThreadId: "PRT" },
        outcome: { ok: true },
      },
    ];
    const out = applyStepResults(localState({ threads: [t] }), results);
    expect(out.threads[0]).toMatchObject({ state: "synced", resolved: true });
  });

  test("SetIssueThreadResolved success marks the Thread synced (issue #270)", () => {
    const t = thread({ id: "t-out", state: "syncing", resolved: true, remoteIssueCommentId: 501 });
    const step = {
      kind: "set-issue-thread-resolved" as const,
      threadId: "t-out",
      issueCommentId: 501,
      resolved: true,
    };
    const ok = applyStepResults(localState({ threads: [t] }), [{ step, outcome: { ok: true } }]);
    expect(ok.threads[0]).toMatchObject({ state: "synced", resolved: true });
  });
});

describe("state-machine — applyStepResults: resolve failure (issue #275)", () => {
  test("a failed resolve-review-thread returns the Thread to synced with resolved reverted and lastError", () => {
    const t = thread({ state: "syncing", remoteThreadId: "PRT", resolved: true });
    const results: StepResult[] = [
      {
        step: { kind: "resolve-review-thread", threadId: "t1", remoteThreadId: "PRT" },
        outcome: { ok: false, error: { message: "boom" } },
      },
    ];
    const out = applyStepResults(localState({ threads: [t] }), results);
    expect(out.threads[0]).toEqual({
      id: "t1",
      state: "synced",
      remoteThreadId: "PRT",
      resolved: false,
      lastError: { message: "boom" },
    });
  });

  test("a failed unresolve-review-thread reverts resolved back to true", () => {
    const t = thread({ state: "syncing", remoteThreadId: "PRT", resolved: false });
    const err = { message: "unauthorized" };
    const results: StepResult[] = [
      {
        step: { kind: "unresolve-review-thread", threadId: "t1", remoteThreadId: "PRT" },
        outcome: { ok: false, error: err },
      },
    ];
    const out = applyStepResults(localState({ threads: [t] }), results);
    expect(out.threads[0]).toMatchObject({ state: "synced", resolved: true, lastError: err });
  });

  test("a failed set-issue-thread-resolved reverts resolved to the opposite of the step", () => {
    const t = thread({ id: "t-out", state: "syncing", remoteIssueCommentId: 501, resolved: false });
    const err = { message: "Forbidden", code: 403 };
    const results: StepResult[] = [
      {
        step: {
          kind: "set-issue-thread-resolved",
          threadId: "t-out",
          issueCommentId: 501,
          resolved: false,
        },
        outcome: { ok: false, error: err },
      },
    ];
    const out = applyStepResults(localState({ threads: [t] }), results);
    expect(out.threads[0]).toMatchObject({ state: "synced", resolved: true, lastError: err });
  });
});

describe("state-machine — applyStepResults: Commit", () => {
  test("Commit success removes every bundled FileEdit", () => {
    const f1 = fileEdit({ id: "f1", state: "syncing" });
    const f2 = fileEdit({ id: "f2", state: "syncing", path: "b.md" });
    const f3 = fileEdit({ id: "f3", state: "draft" }); // unrelated
    const results: StepResult[] = [
      {
        step: {
          kind: "commit",
          baseSha: "h0",
          headRef: "topic",
          fileEdits: [f1, f2],
        },
        outcome: { ok: true, newHeadSha: "h1" },
      },
    ];
    const out = applyStepResults(localState({ fileEdits: [f1, f2, f3] }), results);
    expect(out.fileEdits.map((f) => f.id)).toEqual(["f3"]);
  });

  test("Commit failure reverts every bundled FileEdit to draft + lastError", () => {
    const f = fileEdit({ id: "f", state: "syncing" });
    const err = { message: "non-fast-forward", code: 422 };
    const results: StepResult[] = [
      {
        step: {
          kind: "commit",
          baseSha: "h0",
          headRef: "topic",
          fileEdits: [f],
        },
        outcome: { ok: false, error: err },
      },
    ];
    const out = applyStepResults(localState({ fileEdits: [f] }), results);
    expect(out.fileEdits[0]).toMatchObject({ state: "draft", lastError: err });
  });

  test("a refused Commit parks its FileEdits as draft + lastError (#288)", () => {
    const f = fileEdit({ id: "f", state: "syncing" });
    const err = { message: "The pull request is merged" };
    const results: StepResult[] = [
      {
        step: { kind: "reject-commit", fileEdits: [f], error: err },
        outcome: { ok: false, error: err },
      },
    ];
    const out = applyStepResults(localState({ fileEdits: [f] }), results);
    expect(out.fileEdits[0]).toMatchObject({ state: "draft", lastError: err });
  });
});

describe("state-machine — applyStepResultsToRemote", () => {
  const commitResult = (outcome: CommitOutcome): StepResult => ({
    step: { kind: "commit", baseSha: "h", headRef: "topic", fileEdits: [fileEdit()] },
    outcome,
  });

  test("Commit success advances the head SHA", () => {
    const remote = remoteState({ pullRequest: pr({ headSha: "h" }) });
    const out = applyStepResultsToRemote(remote, [commitResult({ ok: true, newHeadSha: "h2" })]);
    expect(out.pullRequest?.headSha).toBe("h2");
  });

  test("Commit success with no PullRequest in RemoteState is a no-op", () => {
    const remote = remoteState();
    const out = applyStepResultsToRemote(remote, [commitResult({ ok: true, newHeadSha: "h2" })]);
    expect(out.pullRequest).toBeNull();
  });

  test("PostReviewBatch success upserts synced comments and the new thread into the mirror", () => {
    const c = comment({ id: "c1", state: "syncing", threadId: "t1" });
    const remote = remoteState({ pullRequest: pr() });
    const out = applyStepResultsToRemote(remote, [
      {
        step: { kind: "post-review-batch", commitId: "h", comments: [c] },
        outcome: {
          ok: true,
          mappings: [{ cid: "c1", remoteId: 11, remoteThreadId: "PRT_new" }],
        },
      },
    ]);
    expect(out.comments).toContainEqual(
      expect.objectContaining({ id: "c1", state: "synced", remoteId: 11 }),
    );
    expect(out.threads).toContainEqual(
      expect.objectContaining({
        id: "t1",
        state: "synced",
        resolved: false,
        remoteThreadId: "PRT_new",
      }),
    );
  });

  test("PostIssueComment success upserts the synced comment into the mirror", () => {
    const c = comment({ id: "c1", state: "syncing" });
    const out = applyStepResultsToRemote(remoteState({ pullRequest: pr() }), [
      {
        step: { kind: "post-issue-comment", comment: c },
        outcome: { ok: true, mapping: { cid: "c1", remoteId: 22 } },
      },
    ]);
    expect(out.comments).toContainEqual(
      expect.objectContaining({ id: "c1", state: "synced", remoteId: 22 }),
    );
  });

  test("PostIssueComment success mirrors a new out-of-diff Thread into RemoteState (issue #272)", () => {
    const c = comment({ id: "c1", state: "syncing", threadId: "t1" });
    const out = applyStepResultsToRemote(remoteState({ pullRequest: pr() }), [
      {
        step: { kind: "post-issue-comment", comment: c },
        outcome: { ok: true, mapping: { cid: "c1", remoteId: 777 } },
      },
    ]);
    expect(out.threads).toEqual([
      { id: "t1", state: "synced", resolved: false, remoteIssueCommentId: 777 },
    ]);
  });

  test("Resolve / Unresolve success updates the mirrored thread's resolved", () => {
    const t = thread({ id: "t1", state: "synced", remoteThreadId: "PRT", resolved: false });
    const resolved = applyStepResultsToRemote(remoteState({ threads: [t] }), [
      {
        step: { kind: "resolve-review-thread", threadId: "t1", remoteThreadId: "PRT" },
        outcome: { ok: true },
      },
    ]);
    expect(resolved.threads[0]?.resolved).toBe(true);

    const unresolved = applyStepResultsToRemote(resolved, [
      {
        step: { kind: "unresolve-review-thread", threadId: "t1", remoteThreadId: "PRT" },
        outcome: { ok: true },
      },
    ]);
    expect(unresolved.threads[0]?.resolved).toBe(false);
  });

  test("SetIssueThreadResolved success updates the mirrored thread's resolved (issue #270)", () => {
    const t = thread({ id: "t-out", state: "synced", remoteIssueCommentId: 501, resolved: false });
    const out = applyStepResultsToRemote(remoteState({ threads: [t] }), [
      {
        step: {
          kind: "set-issue-thread-resolved",
          threadId: "t-out",
          issueCommentId: 501,
          resolved: true,
        },
        outcome: { ok: true },
      },
    ]);
    expect(out.threads[0]?.resolved).toBe(true);
  });

  test("failed outcomes leave the mirror unchanged", () => {
    const remote = remoteState({
      pullRequest: pr({ headSha: "h" }),
      threads: [thread({ id: "t1", state: "synced", remoteThreadId: "PRT" })],
    });
    const out = applyStepResultsToRemote(remote, [
      commitResult({ ok: false, error: { message: "non-fast-forward" } }),
      {
        step: { kind: "post-review-batch", commitId: "h", comments: [comment()] },
        outcome: { ok: false, error: { message: "422" } },
      },
      {
        step: { kind: "resolve-review-thread", threadId: "t1", remoteThreadId: "PRT" },
        outcome: { ok: false, error: { message: "500" } },
      },
    ]);
    expect(out).toBe(remote);
  });
});

describe("state-machine — mergeRemoteIntoLocal", () => {
  test("draft and syncing local items are preserved", () => {
    const draft = comment({ id: "d", state: "draft" });
    const syncing = comment({ id: "s", state: "syncing" });
    const local = localState({ comments: [draft, syncing] });
    const out = mergeRemoteIntoLocal(local, remoteState({ pullRequest: pr() }));
    expect(out.comments).toEqual([draft, syncing]);
  });

  test("synced local items are replaced by remote counterparts", () => {
    const localC = comment({ id: "c1", state: "synced", remoteId: 1, body: "old" });
    const remoteC = comment({ id: "c1", state: "synced", remoteId: 1, body: "new" });
    const out = mergeRemoteIntoLocal(
      localState({ comments: [localC] }),
      remoteState({ comments: [remoteC] }),
    );
    expect(out.comments).toEqual([remoteC]);
  });

  test("synced local items absent from remote are dropped", () => {
    const localC = comment({ id: "deleted", state: "synced", remoteId: 1 });
    const out = mergeRemoteIntoLocal(
      localState({ comments: [localC] }),
      remoteState(), // empty remote.comments
    );
    expect(out.comments).toEqual([]);
  });

  test("remote items not in local are added", () => {
    const remoteC = comment({ id: "new", state: "synced", remoteId: 99 });
    const out = mergeRemoteIntoLocal(localState(), remoteState({ comments: [remoteC] }));
    expect(out.comments).toEqual([remoteC]);
  });

  test("Threads follow the same protection rule", () => {
    const draftT = thread({ id: "dt", state: "draft" });
    const syncedT = thread({ id: "st", state: "synced", remoteThreadId: "PRT_a" });
    const remoteT = thread({ id: "st", state: "synced", remoteThreadId: "PRT_a", resolved: true });
    const newRemoteT = thread({ id: "newt", state: "synced", remoteThreadId: "PRT_b" });
    const out = mergeRemoteIntoLocal(
      localState({ threads: [draftT, syncedT] }),
      remoteState({ threads: [remoteT, newRemoteT] }),
    );
    expect(out.threads.find((t) => t.id === "dt")).toEqual(draftT);
    expect(out.threads.find((t) => t.id === "st")?.resolved).toBe(true);
    expect(out.threads.find((t) => t.id === "newt")).toEqual(newRemoteT);
  });

  test("adopts a remote Comment whose id matches a protected local item that has no remoteId (issue #266)", () => {
    // The post reached GitHub but the local item never learned its remoteId
    // (unconfirmed post, or a crash before the mapping was persisted).
    const stuckSyncing = comment({ id: "s", state: "syncing" });
    const revertedDraft = comment({ id: "d", state: "draft", lastError: { message: "x" } });
    const remoteS = comment({ id: "s", state: "synced", remoteId: 1 });
    const remoteD = comment({ id: "d", state: "synced", remoteId: 2 });
    const out = mergeRemoteIntoLocal(
      localState({ comments: [stuckSyncing, revertedDraft] }),
      remoteState({ comments: [remoteS, remoteD] }),
    );
    expect(out.comments).toEqual([remoteS, remoteD]);
  });

  test("adopts a remote Thread whose id matches a protected local Thread that has no remoteThreadId (issue #266)", () => {
    const stuck = thread({ id: "t", state: "syncing" });
    const remoteT = thread({ id: "t", state: "synced", remoteThreadId: "PRT_t" });
    const out = mergeRemoteIntoLocal(
      localState({ threads: [stuck] }),
      remoteState({ threads: [remoteT] }),
    );
    expect(out.threads).toEqual([remoteT]);
  });

  test("adopts a remote out-of-diff Thread over a local draft Thread with the same id and no identity (issue #270)", () => {
    const stuck = thread({ id: "t-out", state: "draft" });
    const remoteT = thread({ id: "t-out", state: "synced", remoteIssueCommentId: 501 });
    const out = mergeRemoteIntoLocal(
      localState({ threads: [stuck] }),
      remoteState({ threads: [remoteT] }),
    );
    expect(out.threads).toEqual([remoteT]);
  });

  test("keeps a protected local out-of-diff Thread that already has a remoteIssueCommentId (issue #270)", () => {
    const pending = thread({
      id: "t-out",
      state: "syncing",
      remoteIssueCommentId: 501,
      resolved: true,
    });
    const remoteT = thread({
      id: "t-out",
      state: "synced",
      remoteIssueCommentId: 501,
      resolved: false,
    });
    const out = mergeRemoteIntoLocal(
      localState({ threads: [pending] }),
      remoteState({ threads: [remoteT] }),
    );
    expect(out.threads).toEqual([pending]);
  });

  test("keeps a protected local Thread that already has a remoteThreadId (pending resolve toggle wins)", () => {
    const pending = thread({ id: "t", state: "syncing", remoteThreadId: "PRT_t", resolved: true });
    const remoteT = thread({ id: "t", state: "synced", remoteThreadId: "PRT_t", resolved: false });
    const out = mergeRemoteIntoLocal(
      localState({ threads: [pending] }),
      remoteState({ threads: [remoteT] }),
    );
    expect(out.threads).toEqual([pending]);
  });

  test("FileEdits are not touched by refresh", () => {
    const f = fileEdit({ state: "draft" });
    const local = localState({ fileEdits: [f] });
    expect(mergeRemoteIntoLocal(local, remoteState()).fileEdits).toEqual([f]);
  });
});
