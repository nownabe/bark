import { describe, expect, test } from "bun:test";
import { execute } from "../../lib/pr/executor";
import type {
  CommitStep,
  ExecutionStep,
  PostIssueCommentStep,
  PostReplyStep,
  PostReviewBatchStep,
  ResolveReviewThreadStep,
  SetIssueThreadResolvedStep,
  UnresolveReviewThreadStep,
} from "../../lib/pr/steps";
import type {
  CommitOutcome,
  PostIssueCommentOutcome,
  PostReplyOutcome,
  PostReviewBatchOutcome,
  ResolveOutcome,
  Transport,
} from "../../lib/pr/transport";
import type { Comment, FileEdit } from "../../lib/pr/types";

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

/** FakeTransport records calls and returns scripted outcomes. */
type FakeOptions = {
  postReviewBatch?: PostReviewBatchOutcome;
  postReply?: PostReplyOutcome;
  postIssueComment?: PostIssueCommentOutcome;
  resolveReviewThread?: ResolveOutcome;
  unresolveReviewThread?: ResolveOutcome;
  setIssueThreadResolved?: ResolveOutcome;
  commit?: CommitOutcome;
};

function fakeTransport(opts: FakeOptions = {}): {
  transport: Transport;
  calls: { kind: ExecutionStep["kind"]; step: ExecutionStep }[];
} {
  const calls: { kind: ExecutionStep["kind"]; step: ExecutionStep }[] = [];
  const transport: Transport = {
    async postReviewBatch(step) {
      calls.push({ kind: "post-review-batch", step });
      return opts.postReviewBatch ?? { ok: true, mappings: [] };
    },
    async postReply(step) {
      calls.push({ kind: "post-reply", step });
      return (
        opts.postReply ?? {
          ok: true,
          mapping: { cid: step.comment.id, remoteId: 0 },
        }
      );
    },
    async postIssueComment(step) {
      calls.push({ kind: "post-issue-comment", step });
      return (
        opts.postIssueComment ?? {
          ok: true,
          mapping: { cid: step.comment.id, remoteId: 0 },
        }
      );
    },
    async resolveReviewThread(step) {
      calls.push({ kind: "resolve-review-thread", step });
      return opts.resolveReviewThread ?? { ok: true };
    },
    async unresolveReviewThread(step) {
      calls.push({ kind: "unresolve-review-thread", step });
      return opts.unresolveReviewThread ?? { ok: true };
    },
    async setIssueThreadResolved(step) {
      calls.push({ kind: "set-issue-thread-resolved", step });
      return opts.setIssueThreadResolved ?? { ok: true };
    },
    async commit(step) {
      calls.push({ kind: "commit", step });
      return opts.commit ?? { ok: true, newHeadSha: "new-sha" };
    },
  };
  return { transport, calls };
}

describe("executor — dispatch", () => {
  test("no steps yield no results and no transport calls", async () => {
    const { transport, calls } = fakeTransport();
    expect(await execute([], transport)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a PostReviewBatch step is dispatched to transport.postReviewBatch", async () => {
    const step: PostReviewBatchStep = {
      kind: "post-review-batch",
      commitId: "h1",
      comments: [comment()],
    };
    const { transport, calls } = fakeTransport({
      postReviewBatch: {
        ok: true,
        mappings: [{ cid: "c1", remoteId: 42, remoteThreadId: "PRT_a" }],
      },
    });
    const results = await execute([step], transport);
    expect(calls).toEqual([{ kind: "post-review-batch", step }]);
    expect(results).toEqual([
      {
        step,
        outcome: {
          ok: true,
          mappings: [{ cid: "c1", remoteId: 42, remoteThreadId: "PRT_a" }],
        },
      },
    ]);
  });

  test("a PostReply step is dispatched to transport.postReply", async () => {
    const parent = comment({ id: "p", state: "synced", remoteId: 1 });
    const reply = comment({ id: "r", parentLocalId: "p" });
    const step: PostReplyStep = {
      kind: "post-reply",
      comment: reply,
      parent,
    };
    const { transport, calls } = fakeTransport();
    const results = await execute([step], transport);
    expect(calls).toEqual([{ kind: "post-reply", step }]);
    expect(results[0].outcome).toEqual({
      ok: true,
      mapping: { cid: "r", remoteId: 0 },
    });
  });

  test("a PostIssueComment step is dispatched to transport.postIssueComment", async () => {
    const step: PostIssueCommentStep = {
      kind: "post-issue-comment",
      comment: comment({ id: "c-iss" }),
    };
    const { transport, calls } = fakeTransport();
    const results = await execute([step], transport);
    expect(calls).toEqual([{ kind: "post-issue-comment", step }]);
    expect(results[0].outcome).toMatchObject({ ok: true });
  });

  test("ResolveReviewThread and UnresolveReviewThread dispatch to their own methods", async () => {
    const resolve: ResolveReviewThreadStep = {
      kind: "resolve-review-thread",
      threadId: "t1",
      remoteThreadId: "PRT_a",
    };
    const unresolve: UnresolveReviewThreadStep = {
      kind: "unresolve-review-thread",
      threadId: "t2",
      remoteThreadId: "PRT_b",
    };
    const { transport, calls } = fakeTransport();
    await execute([resolve, unresolve], transport);
    expect(calls.map((c) => c.kind)).toEqual(["resolve-review-thread", "unresolve-review-thread"]);
  });

  test("a SetIssueThreadResolved step is dispatched to transport.setIssueThreadResolved (issue #270)", async () => {
    const step: SetIssueThreadResolvedStep = {
      kind: "set-issue-thread-resolved",
      threadId: "t-out",
      issueCommentId: 501,
      resolved: true,
    };
    const { transport, calls } = fakeTransport();
    const results = await execute([step], transport);
    expect(calls).toEqual([{ kind: "set-issue-thread-resolved", step }]);
    expect(results[0]).toEqual({ step, outcome: { ok: true } });
  });

  test("a Commit step is dispatched to transport.commit", async () => {
    const step: CommitStep = {
      kind: "commit",
      baseSha: "h0",
      headRef: "topic",
      fileEdits: [fileEdit()],
    };
    const { transport, calls } = fakeTransport({
      commit: { ok: true, newHeadSha: "h1" },
    });
    const results = await execute([step], transport);
    expect(calls).toEqual([{ kind: "commit", step }]);
    expect(results[0].outcome).toEqual({ ok: true, newHeadSha: "h1" });
  });
});

describe("executor — ordering and aggregation", () => {
  test("steps are executed in the given order", async () => {
    const parent = comment({ id: "p", state: "synced", remoteId: 1 });
    const a: PostReviewBatchStep = {
      kind: "post-review-batch",
      commitId: "h",
      comments: [comment({ id: "a" })],
    };
    const b: PostReplyStep = {
      kind: "post-reply",
      comment: comment({ id: "b", parentLocalId: "p" }),
      parent,
    };
    const c: CommitStep = {
      kind: "commit",
      baseSha: "h",
      headRef: "topic",
      fileEdits: [fileEdit({ id: "f" })],
    };
    const { transport, calls } = fakeTransport();
    const results = await execute([a, b, c], transport);
    expect(calls.map((x) => x.kind)).toEqual(["post-review-batch", "post-reply", "commit"]);
    expect(results).toHaveLength(3);
  });
});

describe("executor — error pass-through", () => {
  test("a failed step returns its error outcome and does not throw", async () => {
    const step: PostReviewBatchStep = {
      kind: "post-review-batch",
      commitId: "h",
      comments: [comment()],
    };
    const { transport } = fakeTransport({
      postReviewBatch: {
        ok: false,
        error: { message: "422 Unprocessable", code: 422 },
      },
    });
    const results = await execute([step], transport);
    expect(results[0].outcome).toEqual({
      ok: false,
      error: { message: "422 Unprocessable", code: 422 },
    });
  });

  test("a failure on one step does not skip the next step", async () => {
    const parent = comment({ id: "p", state: "synced", remoteId: 1 });
    const reply = comment({ id: "r", parentLocalId: "p" });
    const batch: PostReviewBatchStep = {
      kind: "post-review-batch",
      commitId: "h",
      comments: [comment({ id: "a" })],
    };
    const reply1: PostReplyStep = { kind: "post-reply", comment: reply, parent };

    let replyCalled = false;
    const transport: Transport = {
      async postReviewBatch() {
        return { ok: false, error: { message: "boom" } };
      },
      async postReply() {
        replyCalled = true;
        return { ok: true, mapping: { cid: "r", remoteId: 7 } };
      },
      async postIssueComment() {
        throw new Error("unused");
      },
      async resolveReviewThread() {
        throw new Error("unused");
      },
      async unresolveReviewThread() {
        throw new Error("unused");
      },
      async setIssueThreadResolved() {
        throw new Error("unused");
      },
      async commit() {
        throw new Error("unused");
      },
    };

    const results = await execute([batch, reply1], transport);
    expect(replyCalled).toBe(true);
    expect(results).toHaveLength(2);
    expect(results[0].outcome.ok).toBe(false);
    expect(results[1].outcome.ok).toBe(true);
  });
});
