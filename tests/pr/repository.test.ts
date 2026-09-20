import { describe, expect, mock, test } from "bun:test";
import { deriveAppState } from "../../lib/pr/appstate";
import { PullRequestRepository } from "../../lib/pr/repository";
import { InMemoryStorageAdapter } from "../../lib/pr/storage";
import type {
  CommitOutcome,
  PostIssueCommentOutcome,
  PostReplyOutcome,
  PostReviewBatchOutcome,
  ResolveOutcome,
  Transport,
} from "../../lib/pr/transport";
import type { PostReviewBatchStep, SetIssueThreadResolvedStep } from "../../lib/pr/steps";
import { emptyState } from "../../lib/pr/types";
import type {
  Comment,
  FileEdit,
  LocalState,
  PullRequest,
  Range,
  RemoteState,
  Thread,
} from "../../lib/pr/types";

const author = { login: "alice" };
// Anchored at pr()'s head sha; drafts at an older sha are exercised by the
// issue #265 tests below.
const anchor = {
  sha: "h",
  range: { sl: 1, sc: 1, el: 1, ec: 10 },
  quote: "hello",
};

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    state: "draft",
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
    state: "draft",
    resolved: false,
    ...overrides,
  };
}

function fileEdit(overrides: Partial<FileEdit> = {}): FileEdit {
  return {
    id: "f1",
    state: "draft",
    path: "README.md",
    baseSha: "h",
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

/** Transport that succeeds and assigns predictable remoteIds. */
function happyTransport(
  opts: {
    remoteThreadIdForBatch?: string;
  } = {},
): { transport: Transport; calls: string[]; commitBaseShas: string[] } {
  const calls: string[] = [];
  const commitBaseShas: string[] = [];
  let nextRemoteId = 100;
  let headSeq = 1;
  const transport: Transport = {
    async postReviewBatch(step): Promise<PostReviewBatchOutcome> {
      calls.push("post-review-batch");
      return {
        ok: true,
        mappings: step.comments.map((c, idx) => ({
          cid: c.id,
          remoteId: nextRemoteId++,
          ...(idx === 0 && opts.remoteThreadIdForBatch
            ? { remoteThreadId: opts.remoteThreadIdForBatch }
            : {}),
        })),
      };
    },
    async postReply(step): Promise<PostReplyOutcome> {
      calls.push("post-reply");
      return { ok: true, mapping: { cid: step.comment.id, remoteId: nextRemoteId++ } };
    },
    async postIssueComment(step): Promise<PostIssueCommentOutcome> {
      calls.push("post-issue-comment");
      return { ok: true, mapping: { cid: step.comment.id, remoteId: nextRemoteId++ } };
    },
    async resolveReviewThread(): Promise<ResolveOutcome> {
      calls.push("resolve-review-thread");
      return { ok: true };
    },
    async unresolveReviewThread(): Promise<ResolveOutcome> {
      calls.push("unresolve-review-thread");
      return { ok: true };
    },
    async setIssueThreadResolved(): Promise<ResolveOutcome> {
      calls.push("set-issue-thread-resolved");
      return { ok: true };
    },
    async commit(step): Promise<CommitOutcome> {
      calls.push("commit");
      commitBaseShas.push(step.baseSha);
      return { ok: true, newHeadSha: `h${++headSeq}` };
    },
  };
  return { transport, calls, commitBaseShas };
}

function makeRepo(transport: Transport, isInDiff: (c: Comment) => boolean = () => true) {
  return new PullRequestRepository({
    storage: new InMemoryStorageAdapter(),
    transport,
    isInDiff,
  });
}

describe("repository — persistence", () => {
  test("upsertComment persists and hydrate restores", async () => {
    const storage = new InMemoryStorageAdapter();
    const r1 = new PullRequestRepository({
      storage,
      transport: happyTransport().transport,
      isInDiff: () => true,
    });
    await r1.upsertComment(comment({ id: "c1" }));
    await r1.upsertComment(comment({ id: "c2" }));

    const r2 = new PullRequestRepository({
      storage,
      transport: happyTransport().transport,
      isInDiff: () => true,
    });
    await r2.hydrate();
    expect(r2.getLocalState().comments.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  test("hydrate downgrades items left syncing by a previous session to draft (issue #266 path C)", async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.save({
      ...emptyState(),
      comments: [comment({ id: "c1", state: "syncing", threadId: "t1" })],
      threads: [thread({ id: "t1", state: "syncing" })],
      fileEdits: [fileEdit({ id: "f1", state: "syncing" })],
    });
    const r = new PullRequestRepository({
      storage,
      transport: happyTransport().transport,
      isInDiff: () => true,
    });

    await r.hydrate();

    // No step is in flight in a fresh session, so nothing would ever advance
    // these; as drafts they at least show up in the UI again.
    expect(r.getLocalState().comments[0]?.state).toBe("draft");
    expect(r.getLocalState().threads[0]?.state).toBe("draft");
    expect(r.getLocalState().fileEdits[0]?.state).toBe("draft");
  });

  test("hydrate on an empty store keeps state empty", async () => {
    const r = makeRepo(happyTransport().transport);
    await r.hydrate();
    expect(r.getLocalState().comments).toEqual([]);
  });
});

describe("repository — persist failure (issue #289)", () => {
  /** In-memory adapter whose first `save` rejects, as a full quota would. */
  function failOnceStorage() {
    const inner = new InMemoryStorageAdapter();
    let failed = false;
    return {
      load: () => inner.load(),
      async save(state: LocalState) {
        if (failed) return await inner.save(state);
        failed = true;
        throw new Error("QUOTA_BYTES quota exceeded");
      },
      loadDirect: () => inner.load(),
    };
  }

  test("a rejected save keeps the draft in memory and reports the error", async () => {
    const storage = failOnceStorage();
    const onPersistError = mock((_e: unknown) => {});
    const r = new PullRequestRepository({
      storage,
      transport: happyTransport().transport,
      isInDiff: () => true,
      onPersistError,
    });

    await r.upsertComment(comment({ id: "c1" }));

    expect(r.getLocalState().comments.map((c) => c.id)).toEqual(["c1"]);
    expect(onPersistError).toHaveBeenCalledTimes(1);
    const [reported] = onPersistError.mock.calls[0] as [unknown];
    expect((reported as Error).message).toContain("quota exceeded");
  });

  test("the next successful save catches up on what the failed one dropped", async () => {
    const storage = failOnceStorage();
    const r = new PullRequestRepository({
      storage,
      transport: happyTransport().transport,
      isInDiff: () => true,
    });

    await r.upsertComment(comment({ id: "c1" }));
    await r.upsertComment(comment({ id: "c2" }));

    expect((await storage.loadDirect())?.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("repository — subscription", () => {
  test("subscribers are notified on each mutation", async () => {
    const r = makeRepo(happyTransport().transport);
    let count = 0;
    r.subscribe(() => {
      count++;
    });
    await r.upsertComment(comment());
    await r.upsertComment(comment({ id: "c2" }));
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("unsubscribing stops further notifications", async () => {
    const r = makeRepo(happyTransport().transport);
    let count = 0;
    const off = r.subscribe(() => {
      count++;
    });
    await r.upsertComment(comment());
    off();
    await r.upsertComment(comment({ id: "c2" }));
    expect(count).toBe(1);
  });
});

describe("repository — mutations", () => {
  test("upsertComment inserts then updates by id", async () => {
    const r = makeRepo(happyTransport().transport);
    await r.upsertComment(comment({ id: "x", body: "v1" }));
    await r.upsertComment(comment({ id: "x", body: "v2" }));
    expect(r.getLocalState().comments).toHaveLength(1);
    expect(r.getLocalState().comments[0]?.body).toBe("v2");
  });

  test("discardComment removes by id", async () => {
    const r = makeRepo(happyTransport().transport);
    await r.upsertComment(comment({ id: "a" }));
    await r.upsertComment(comment({ id: "b" }));
    await r.discardComment("a");
    expect(r.getLocalState().comments.map((c) => c.id)).toEqual(["b"]);
  });

  test("upsertComment of a top-level draft creates a draft Thread with the same id (issue #272)", async () => {
    const r = makeRepo(happyTransport().transport);
    await r.upsertComment(comment());
    expect(r.getLocalState().threads).toEqual([{ id: "t1", state: "draft", resolved: false }]);
  });

  test("upsertComment of a reply creates no Thread", async () => {
    const r = makeRepo(happyTransport().transport);
    await r.upsertComment(comment({ id: "c2", parentLocalId: "c1" }));
    expect(r.getLocalState().threads).toEqual([]);
  });

  test("upsertComment never overwrites an existing Thread", async () => {
    const r = makeRepo(happyTransport().transport);
    const existing = thread({ state: "synced", remoteThreadId: "PRT", resolved: true });
    await r.upsertThread(existing);
    await r.upsertComment(comment());
    expect(r.getLocalState().threads).toEqual([existing]);
  });

  test("discarding the last comment of a draft Thread removes the Thread (issue #272)", async () => {
    const r = makeRepo(happyTransport().transport);
    await r.upsertComment(comment());
    await r.discardComment("c1");
    expect(r.getLocalState().threads).toEqual([]);
  });

  test("discardComment cascades to replies and replies of replies (issue #271)", async () => {
    const r = makeRepo(happyTransport().transport);
    await r.upsertComment(comment({ id: "c1" }));
    await r.upsertComment(comment({ id: "c2", parentLocalId: "c1" }));
    await r.upsertComment(comment({ id: "c3", parentLocalId: "c2" }));

    await r.discardComment("c1");

    expect(r.getLocalState().comments).toEqual([]);
    expect(r.getLocalState().threads).toEqual([]);
  });
});

describe("repository — submitDrafts pipeline", () => {
  test("flips drafts to syncing, runs the pipeline, and lands at synced on success", async () => {
    const { transport, calls } = happyTransport({ remoteThreadIdForBatch: "PRT_new" });
    const r = makeRepo(transport);
    await r.setRemoteState({ ...r.getRemoteState(), pullRequest: pr() });
    await r.upsertThread(thread({ id: "t1", state: "draft" }));
    await r.upsertComment(comment({ id: "c1", state: "draft", threadId: "t1" }));

    await r.submitDrafts();

    expect(calls).toContain("post-review-batch");
    expect(r.getLocalState().comments[0]?.state).toBe("synced");
    expect(r.getLocalState().comments[0]?.remoteId).toBe(100);
    expect(r.getLocalState().threads[0]?.state).toBe("synced");
    expect(r.getLocalState().threads[0]?.remoteThreadId).toBe("PRT_new");
  });

  test("reply chains converge across reconcile cycles", async () => {
    const { transport, calls } = happyTransport({ remoteThreadIdForBatch: "PRT_p" });
    const r = makeRepo(transport);
    await r.setRemoteState({ ...r.getRemoteState(), pullRequest: pr() });
    await r.upsertThread(thread({ id: "t1", state: "draft" }));
    await r.upsertComment(comment({ id: "parent", state: "draft", threadId: "t1" }));
    await r.upsertComment(
      comment({
        id: "reply",
        state: "draft",
        threadId: "t1",
        parentLocalId: "parent",
      }),
    );

    await r.submitDrafts();

    // Cycle 1: PostReviewBatch creates parent. Cycle 2: PostReply for reply.
    expect(calls).toEqual(["post-review-batch", "post-reply"]);
    expect(r.getLocalState().comments.every((c) => c.state === "synced")).toBe(true);
  });

  test("failure on the batch reverts every batched comment to draft + lastError", async () => {
    const calls: string[] = [];
    const failingTransport: Transport = {
      ...happyTransport().transport,
      async postReviewBatch() {
        calls.push("post-review-batch");
        return { ok: false, error: { message: "422 Unprocessable" } };
      },
    };
    const r = makeRepo(failingTransport);
    await r.setRemoteState({ ...r.getRemoteState(), pullRequest: pr() });
    await r.upsertThread(thread({ id: "t1", state: "draft" }));
    await r.upsertComment(comment({ id: "c1", state: "draft", threadId: "t1" }));

    await r.submitDrafts();

    expect(r.getLocalState().comments[0]?.state).toBe("draft");
    expect(r.getLocalState().comments[0]?.lastError?.message).toBe("422 Unprocessable");
  });

  test("a posted-but-unconfirmed comment is adopted from the next refresh instead of being posted twice (issue #266 path A)", async () => {
    const calls: string[] = [];
    const unconfirmingTransport: Transport = {
      ...happyTransport().transport,
      async postReviewBatch(): Promise<PostReviewBatchOutcome> {
        calls.push("post-review-batch");
        // POST succeeded; the identity listing lagged and returned nothing.
        return { ok: true, mappings: [] };
      },
    };
    const r = makeRepo(unconfirmingTransport);
    await r.setRemoteState({ ...r.getRemoteState(), pullRequest: pr() });
    await r.upsertThread(thread({ id: "t1", state: "draft" }));
    await r.upsertComment(comment({ id: "c1", state: "draft", threadId: "t1" }));

    await r.submitDrafts();
    expect(r.getLocalState().comments[0]?.state).toBe("draft");
    expect(r.getLocalState().comments[0]?.lastError).toBeDefined();

    // The next refresh sees the comment on GitHub, carrying our cid.
    await r.setRemoteState({
      ...r.getRemoteState(),
      comments: [comment({ id: "c1", state: "synced", remoteId: 100, threadId: "t1" })],
      threads: [thread({ id: "t1", state: "synced", remoteThreadId: "PRT_new" })],
    });
    expect(r.getLocalState().comments[0]).toMatchObject({ state: "synced", remoteId: 100 });
    expect(r.getLocalState().threads[0]).toMatchObject({
      state: "synced",
      remoteThreadId: "PRT_new",
    });

    await r.submitDrafts();
    expect(calls).toEqual(["post-review-batch"]);
  });

  test("Commit success removes the FileEdit", async () => {
    const { transport } = happyTransport();
    const r = makeRepo(transport);
    await r.setRemoteState({ ...r.getRemoteState(), pullRequest: pr() });
    await r.upsertFileEdit(fileEdit({ id: "f1", state: "draft" }));

    await r.submitDrafts();

    expect(r.getLocalState().fileEdits).toEqual([]);
  });

  test("submitDrafts mirrors posted comments and new threads into RemoteState", async () => {
    const { transport } = happyTransport({ remoteThreadIdForBatch: "PRT_new" });
    const r = makeRepo(transport);
    await r.setRemoteState({ ...r.getRemoteState(), pullRequest: pr() });
    await r.upsertThread(thread({ id: "t1", state: "draft" }));
    await r.upsertComment(comment({ id: "c1", state: "draft", threadId: "t1" }));

    await r.submitDrafts();

    expect(r.getRemoteState().comments).toContainEqual(
      expect.objectContaining({ id: "c1", state: "synced", remoteId: 100 }),
    );
    expect(r.getRemoteState().threads).toContainEqual(
      expect.objectContaining({ id: "t1", state: "synced", remoteThreadId: "PRT_new" }),
    );
  });

  test("Commit success advances RemoteState's head SHA to newHeadSha", async () => {
    const { transport } = happyTransport();
    const r = makeRepo(transport);
    await r.setRemoteState({ ...r.getRemoteState(), pullRequest: pr() });
    await r.upsertFileEdit(fileEdit({ id: "f1", state: "draft" }));

    await r.submitDrafts();

    expect(r.getRemoteState().pullRequest?.headSha).toBe("h2");
  });

  test("a second submit commits on top of the advanced head, not the stale one", async () => {
    const { transport, commitBaseShas } = happyTransport();
    const r = makeRepo(transport);
    await r.setRemoteState({ ...r.getRemoteState(), pullRequest: pr() });

    await r.upsertFileEdit(fileEdit({ id: "f1", state: "draft" }));
    await r.submitDrafts();

    await r.upsertFileEdit(fileEdit({ id: "f2", state: "draft", editedSource: "edited again" }));
    await r.submitDrafts();

    // Second commit must be parented on the head created by the first commit;
    // a stale "h" base makes GitHub reject the ref update as non-fast-forward.
    expect(commitBaseShas).toEqual(["h", "h2"]);
    expect(r.getRemoteState().pullRequest?.headSha).toBe("h3");
  });

  test("Commit failure leaves the head SHA unchanged", async () => {
    const failingTransport: Transport = {
      ...happyTransport().transport,
      async commit(): Promise<CommitOutcome> {
        return { ok: false, error: { message: "422 Update is not a fast forward" } };
      },
    };
    const r = makeRepo(failingTransport);
    await r.setRemoteState({ ...r.getRemoteState(), pullRequest: pr() });
    await r.upsertFileEdit(fileEdit({ id: "f1", state: "draft" }));

    await r.submitDrafts();

    expect(r.getRemoteState().pullRequest?.headSha).toBe("h");
    expect(r.getLocalState().fileEdits[0]?.state).toBe("draft");
  });

  test("no PullRequest in RemoteState → sync is a no-op (does not throw)", async () => {
    const { transport, calls } = happyTransport();
    const r = makeRepo(transport);
    await r.upsertComment(comment({ id: "c1", state: "draft" }));
    await r.submitDrafts();
    expect(calls).toEqual([]);
    // Comment was still flipped to syncing — but cannot proceed without PR context.
    expect(r.getLocalState().comments[0]?.state).toBe("syncing");
  });
});

describe("repository — setThreadResolved", () => {
  test("a synced Thread → syncing → synced via ResolveReviewThread", async () => {
    const { transport, calls } = happyTransport();
    const r = makeRepo(transport);
    await r.setRemoteState({
      ...r.getRemoteState(),
      pullRequest: pr(),
      threads: [thread({ id: "t1", state: "synced", remoteThreadId: "PRT" })],
    });
    await r.upsertThread(thread({ id: "t1", state: "synced", remoteThreadId: "PRT" }));

    await r.setThreadResolved("t1", true);

    expect(calls).toEqual(["resolve-review-thread"]);
    expect(r.getLocalState().threads[0]?.state).toBe("synced");
    expect(r.getLocalState().threads[0]?.resolved).toBe(true);
  });

  test("resolve then unresolve in one session both reach GitHub", async () => {
    const { transport, calls } = happyTransport();
    const r = makeRepo(transport);
    await r.setRemoteState({
      ...r.getRemoteState(),
      pullRequest: pr(),
      threads: [thread({ id: "t1", state: "synced", remoteThreadId: "PRT", resolved: false })],
    });
    await r.upsertThread(thread({ id: "t1", state: "synced", remoteThreadId: "PRT" }));

    await r.setThreadResolved("t1", true);
    await r.setThreadResolved("t1", false);

    // Without mirroring the resolve into RemoteState, the reconciler sees
    // desired=false vs remote=false on the second toggle, emits nothing, and
    // the thread is stuck syncing forever.
    expect(calls).toEqual(["resolve-review-thread", "unresolve-review-thread"]);
    expect(r.getLocalState().threads[0]).toMatchObject({ state: "synced", resolved: false });
  });

  test("a draft Thread just updates the field without dispatching", async () => {
    const { transport, calls } = happyTransport();
    const r = makeRepo(transport);
    await r.setRemoteState({ ...r.getRemoteState(), pullRequest: pr() });
    await r.upsertThread(thread({ id: "t1", state: "draft", resolved: false }));

    await r.setThreadResolved("t1", true);

    expect(calls).toEqual([]);
    expect(r.getLocalState().threads[0]?.state).toBe("draft");
    expect(r.getLocalState().threads[0]?.resolved).toBe(true);
  });

  test("setting resolved to the value remote already has completes instead of sticking in syncing (issue #188)", async () => {
    // A stale click (or a refresh landing between render and click) can ask
    // for the state the thread is already in remotely. The reconciler emits
    // nothing for it, so without a no-op completion the thread would persist
    // in "syncing" forever — merge protects syncing entities, so even a
    // refresh can't release it.
    const { transport, calls } = happyTransport();
    const r = makeRepo(transport);
    await r.setRemoteState({
      ...r.getRemoteState(),
      pullRequest: pr(),
      threads: [thread({ id: "t1", state: "synced", remoteThreadId: "PRT", resolved: false })],
    });

    await r.setThreadResolved("t1", false); // remote is already false

    expect(calls).toEqual([]); // nothing to push
    expect(r.getLocalState().threads[0]).toMatchObject({ state: "synced", resolved: false });
  });

  test("a failed resolve leaves the Thread synced and unresolved; the retry succeeds (issues #188, #275)", async () => {
    let fail = true;
    const { transport, calls } = happyTransport();
    const flaky: Transport = {
      ...transport,
      async resolveReviewThread(step): Promise<ResolveOutcome> {
        if (fail) {
          calls.push("resolve-review-thread(fail)");
          return { ok: false, error: { message: "boom" } };
        }
        return transport.resolveReviewThread(step);
      },
    };
    const r = makeRepo(flaky);
    await r.setRemoteState({
      ...r.getRemoteState(),
      pullRequest: pr(),
      threads: [thread({ id: "t1", state: "synced", remoteThreadId: "PRT", resolved: false })],
    });

    await r.setThreadResolved("t1", true);
    // A thread that exists on GitHub never becomes a draft: the toggle is
    // rolled back to the remote value and the error is surfaced (issue #275).
    expect(r.getLocalState().threads[0]).toMatchObject({ state: "synced", resolved: false });
    expect(r.getLocalState().threads[0]?.lastError?.message).toBe("boom");

    fail = false;
    await r.setThreadResolved("t1", true);

    expect(calls).toEqual(["resolve-review-thread(fail)", "resolve-review-thread"]);
    expect(r.getLocalState().threads[0]).toMatchObject({
      state: "synced",
      resolved: true,
      lastError: undefined,
    });
  });

  test("an out-of-diff thread resolves via SetIssueThreadResolved and stays resolved across refresh and reload (issue #270)", async () => {
    const { transport } = happyTransport();
    const steps: SetIssueThreadResolvedStep[] = [];
    const storage = new InMemoryStorageAdapter();
    const repoWith = () =>
      new PullRequestRepository({
        storage,
        transport: {
          ...transport,
          async setIssueThreadResolved(step): Promise<ResolveOutcome> {
            steps.push(step);
            return { ok: true };
          },
        },
        isInDiff: () => false,
      });
    const outThread = (resolved: boolean): Thread => ({
      id: "t-out",
      state: "synced",
      remoteIssueCommentId: 501,
      resolved,
    });

    const r = repoWith();
    await r.setRemoteState({ ...emptyState(), pullRequest: pr(), threads: [outThread(false)] });

    await r.setThreadResolved("t-out", true);

    expect(steps).toEqual([
      { kind: "set-issue-thread-resolved", threadId: "t-out", issueCommentId: 501, resolved: true },
    ]);
    expect(r.getLocalState().threads[0]).toMatchObject({ state: "synced", resolved: true });
    expect(r.getRemoteState().threads[0]?.resolved).toBe(true);

    // Next refresh: the fetcher reports the fence-backed resolved state.
    await r.setRemoteState({ ...emptyState(), pullRequest: pr(), threads: [outThread(true)] });
    expect(r.getLocalState().threads[0]).toMatchObject({ state: "synced", resolved: true });

    // New session on the same storage: the thread renders resolved.
    const r2 = repoWith();
    await r2.hydrate();
    await r2.setRemoteState({ ...emptyState(), pullRequest: pr(), threads: [outThread(true)] });
    const app = deriveAppState(r2.getLocalState(), r2.getRemoteState());
    expect(app.threadGroups.find((g) => g.thread.id === "t-out")?.thread.resolved).toBe(true);
  });
});

describe("repository — deferred replies (issue #271)", () => {
  test("a reply whose parent fails to post ends the submit as draft + lastError", async () => {
    const failingTransport: Transport = {
      ...happyTransport().transport,
      async postReviewBatch(): Promise<PostReviewBatchOutcome> {
        return { ok: false, error: { message: "boom" } };
      },
    };
    const r = makeRepo(failingTransport);
    await r.setRemoteState({ ...emptyState(), pullRequest: pr() });
    await r.upsertComment(comment({ id: "c1" }));
    await r.upsertComment(comment({ id: "c2", parentLocalId: "c1" }));

    await r.submitDrafts();

    const byId = new Map(r.getLocalState().comments.map((c) => [c.id, c]));
    expect(byId.get("c1")).toMatchObject({ state: "draft", lastError: { message: "boom" } });
    expect(byId.get("c2")?.state).toBe("draft");
    expect(byId.get("c2")?.lastError?.message).toContain("was not posted");
  });

  test("a reply whose parent no longer exists ends the submit as draft with a 'no longer exists' error", async () => {
    const r = makeRepo(happyTransport().transport);
    await r.setRemoteState({ ...emptyState(), pullRequest: pr() });
    await r.upsertComment(comment({ id: "c2", parentLocalId: "gone" }));

    await r.submitDrafts();

    expect(r.getLocalState().comments[0]?.state).toBe("draft");
    expect(r.getLocalState().comments[0]?.lastError?.message).toContain("no longer exists");
  });

  test("a reply chain still syncs across two cycles", async () => {
    const { transport, calls } = happyTransport({ remoteThreadIdForBatch: "PRT_p" });
    const r = makeRepo(transport);
    await r.setRemoteState({ ...emptyState(), pullRequest: pr() });
    await r.upsertComment(comment({ id: "c1" }));
    await r.upsertComment(comment({ id: "c2", parentLocalId: "c1" }));

    await r.submitDrafts();

    expect(calls).toEqual(["post-review-batch", "post-reply"]);
    expect(r.getLocalState().comments.every((c) => c.state === "synced")).toBe(true);
  });
});

describe("repository — out-of-diff threads (issue #272)", () => {
  test("a freshly submitted out-of-diff thread is resolvable in the same session", async () => {
    const { transport, calls } = happyTransport();
    const r = makeRepo(transport, () => false);
    await r.setRemoteState({ ...emptyState(), pullRequest: pr() });
    await r.upsertComment(comment());

    await r.submitDrafts();
    await r.setThreadResolved("t1", true);

    expect(calls).toEqual(["post-issue-comment", "set-issue-thread-resolved"]);
    expect(r.getLocalState().threads[0]).toMatchObject({
      state: "synced",
      resolved: true,
      remoteIssueCommentId: 100,
    });
  });
});

describe("repository — drafts created at an older head (issue #265)", () => {
  test("submit posts a draft at its line in the current head, not its creation-sha line", async () => {
    // Head A: the draft quotes "target line" at line 3. Head B inserts two
    // lines above it, so the same sentence now sits at line 5. A review is
    // posted against one commit_id, so the line numbers sent with it must
    // be in that commit's coordinates.
    const sourceA = ["intro", "more", "target line", "outro"].join("\n");
    const sourceB = ["intro", "new 1", "new 2", "more", "target line", "outro"].join("\n");
    const draft = comment({
      id: "c1",
      state: "draft",
      threadId: "t1",
      path: "README.md",
      anchor: { sha: "A", range: { sl: 3, sc: 1, el: 3, ec: 12 }, quote: "target line" },
    });

    const posted: PostReviewBatchStep[] = [];
    const routed: Range[] = [];
    const { transport } = happyTransport();
    const recording: Transport = {
      ...transport,
      async postReviewBatch(step) {
        posted.push(step);
        return transport.postReviewBatch(step);
      },
    };
    const r = makeRepo(recording, (c) => {
      routed.push(c.anchor.range);
      return true;
    });
    await r.setRemoteState({
      ...r.getRemoteState(),
      pullRequest: pr({ headSha: "B" }),
      fileContents: [
        { sha: "A", path: "README.md", source: sourceA },
        { sha: "B", path: "README.md", source: sourceB },
      ],
    });
    await r.upsertThread(thread({ id: "t1", state: "draft" }));
    await r.upsertComment(draft);

    await r.submitDrafts();

    const mapped: Range = { sl: 5, sc: 1, el: 5, ec: 12 };
    expect(posted).toHaveLength(1);
    expect(posted[0]?.commitId).toBe("B");
    expect(posted[0]?.comments[0]?.anchor).toEqual({
      sha: "B",
      range: mapped,
      quote: "target line",
    });
    // In-diff routing is decided against the current diff, so it must see
    // the mapped range as well, not the creation-sha one.
    expect(routed).toEqual([mapped]);
  });

  test("a draft whose lines no longer exist in the head is refused, not posted with stale lines", async () => {
    // Head B deletes the line that c2 quoted, so its anchor cannot be
    // mapped. Posting it with sha-A lines would land it on unrelated text
    // or 422 the whole review; instead it goes back to draft with an error
    // while the mappable c1 still gets posted.
    const sourceA = ["intro", "kept line", "doomed line", "outro"].join("\n");
    const sourceB = ["intro", "new 1", "kept line", "outro"].join("\n");
    const posted: PostReviewBatchStep[] = [];
    const { transport } = happyTransport({ remoteThreadIdForBatch: "PRT_1" });
    const recording: Transport = {
      ...transport,
      async postReviewBatch(step) {
        posted.push(step);
        return transport.postReviewBatch(step);
      },
    };
    const r = makeRepo(recording);
    await r.setRemoteState({
      ...r.getRemoteState(),
      pullRequest: pr({ headSha: "B" }),
      fileContents: [
        { sha: "A", path: "README.md", source: sourceA },
        { sha: "B", path: "README.md", source: sourceB },
      ],
    });
    await r.upsertThread(thread({ id: "t1", state: "draft" }));
    await r.upsertThread(thread({ id: "t2", state: "draft" }));
    await r.upsertComment(
      comment({
        id: "c1",
        state: "draft",
        threadId: "t1",
        anchor: { sha: "A", range: { sl: 2, sc: 1, el: 2, ec: 10 }, quote: "kept line" },
      }),
    );
    await r.upsertComment(
      comment({
        id: "c2",
        state: "draft",
        threadId: "t2",
        anchor: { sha: "A", range: { sl: 3, sc: 1, el: 3, ec: 12 }, quote: "doomed line" },
      }),
    );

    await r.submitDrafts();

    expect(posted).toHaveLength(1);
    expect(posted[0]?.comments.map((c) => c.id)).toEqual(["c1"]);
    const byId = new Map(r.getLocalState().comments.map((c) => [c.id, c]));
    expect(byId.get("c1")).toMatchObject({ state: "synced", remoteId: 100 });
    expect(byId.get("c2")).toMatchObject({ state: "draft" });
    expect(byId.get("c2")?.lastError?.message).toMatch(/current head/);
    // The never-posted thread must not stay stuck in syncing.
    expect(r.getLocalState().threads.find((t) => t.id === "t2")).toMatchObject({
      state: "draft",
    });
  });
});

describe("repository — refresh serialisation (issue #281)", () => {
  /** A promise whose settlement the test controls. */
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  test("a refresh fetched before a commit cannot regress headSha after it", async () => {
    const { transport, commitBaseShas } = happyTransport();
    const r = makeRepo(transport);
    await r.setRemoteState({ ...emptyState(), pullRequest: pr() });
    await r.upsertFileEdit(fileEdit());

    // The fetch started before the commit and returns the pre-commit head.
    const fetched = deferred<RemoteState>();
    const refreshing = r.refresh(() => fetched.promise);
    const submitting = r.submitDrafts();
    fetched.resolve({ ...emptyState(), pullRequest: pr({ headSha: "h" }) });
    await Promise.all([refreshing, submitting]);

    expect(commitBaseShas).toEqual(["h"]);
    expect(r.getRemoteState().pullRequest?.headSha).toBe("h2");
  });

  test("a submit started during a refresh waits for it and commits on the refreshed head", async () => {
    const { transport, commitBaseShas } = happyTransport();
    const r = makeRepo(transport);
    await r.setRemoteState({ ...emptyState(), pullRequest: pr() });
    await r.upsertFileEdit(fileEdit());

    const fetched = deferred<RemoteState>();
    const refreshing = r.refresh(() => fetched.promise);
    const submitting = r.submitDrafts();
    fetched.resolve({ ...emptyState(), pullRequest: pr({ headSha: "h9" }) });
    await Promise.all([refreshing, submitting]);

    expect(commitBaseShas).toEqual(["h9"]);
  });

  test("concurrent refresh triggers coalesce to one running plus one queued", async () => {
    const r = makeRepo(happyTransport().transport);
    const first = deferred<RemoteState>();
    let fetchCount = 0;
    const fetchRemote = () => {
      fetchCount++;
      return fetchCount === 1 ? first.promise : Promise.resolve({ ...emptyState() });
    };

    const p1 = r.refresh(fetchRemote);
    const p2 = r.refresh(fetchRemote);
    const p3 = r.refresh(fetchRemote);
    expect(p2).toBe(p3);
    first.resolve({ ...emptyState(), pullRequest: pr() });
    await Promise.all([p1, p2, p3]);

    expect(fetchCount).toBe(2);
  });

  test("a failing fetch rejects that refresh, leaves RemoteState untouched, and does not poison the lock", async () => {
    const r = makeRepo(happyTransport().transport);
    await r.setRemoteState({ ...emptyState(), pullRequest: pr() });

    await expect(r.refresh(() => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    expect(r.getRemoteState().pullRequest?.headSha).toBe("h");

    await r.refresh(() => Promise.resolve({ ...emptyState(), pullRequest: pr({ headSha: "hX" }) }));
    expect(r.getRemoteState().pullRequest?.headSha).toBe("hX");
  });
});

describe("repository — setRemoteState (conflict policy)", () => {
  test("synced local items are overwritten by remote and drafts are preserved", async () => {
    const r = makeRepo(happyTransport().transport);
    const draftC = comment({ id: "d", state: "draft" });
    const oldSynced = comment({ id: "s", state: "synced", remoteId: 1, body: "old" });
    await r.upsertComment(draftC);
    await r.upsertComment(oldSynced);

    const newSynced = comment({ id: "s", state: "synced", remoteId: 1, body: "new" });
    await r.setRemoteState({
      ...r.getRemoteState(),
      pullRequest: pr(),
      comments: [newSynced],
    });

    const ids = r.getLocalState().comments.map((c) => ({ id: c.id, body: c.body }));
    expect(ids).toContainEqual({ id: "d", body: draftC.body });
    expect(ids).toContainEqual({ id: "s", body: "new" });
  });
});
