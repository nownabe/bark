import { describe, expect, test } from "bun:test";
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
import type { Comment, FileEdit, PullRequest, Thread } from "../../lib/pr/types";

const author = { login: "alice" };
const anchor = {
  sha: "deadbeef",
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

  test("hydrate on an empty store keeps state empty", async () => {
    const r = makeRepo(happyTransport().transport);
    await r.hydrate();
    expect(r.getLocalState().comments).toEqual([]);
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
