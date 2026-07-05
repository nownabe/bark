import { describe, expect, test } from "bun:test";
import type { ReconcileOperation } from "../../lib/pr/operations";
import { planExecution, type PlannerContext } from "../../lib/pr/planner";
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

function context(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    isInDiff: () => true,
    headSha: "current-head",
    headRef: "topic",
    ...overrides,
  };
}

describe("planner — empty / simple cases", () => {
  test("no Ops produces no Steps", () => {
    expect(planExecution([], context())).toEqual([]);
  });
});

describe("planner — CreateComment routing", () => {
  test("a single in-diff CreateComment becomes one PostReviewBatch", () => {
    const c = comment();
    const ops: ReconcileOperation[] = [{ kind: "create-comment", comment: c }];
    const steps = planExecution(ops, context({ isInDiff: () => true }));
    expect(steps).toEqual([
      {
        kind: "post-review-batch",
        commitId: "current-head",
        comments: [c],
      },
    ]);
  });

  test("multiple in-diff CreateComments bundle into one PostReviewBatch", () => {
    const c1 = comment({ id: "c1", threadId: "t1" });
    const c2 = comment({ id: "c2", threadId: "t2" });
    const c3 = comment({ id: "c3", threadId: "t3" });
    const ops: ReconcileOperation[] = [
      { kind: "create-comment", comment: c1 },
      { kind: "create-comment", comment: c2 },
      { kind: "create-comment", comment: c3 },
    ];
    const steps = planExecution(ops, context({ isInDiff: () => true }));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({
      kind: "post-review-batch",
      commitId: "current-head",
      comments: [c1, c2, c3],
    });
  });

  test("a single out-of-diff CreateComment becomes one PostIssueComment", () => {
    const c = comment();
    const ops: ReconcileOperation[] = [{ kind: "create-comment", comment: c }];
    const steps = planExecution(ops, context({ isInDiff: () => false }));
    expect(steps).toEqual([{ kind: "post-issue-comment", comment: c }]);
  });

  test("multiple out-of-diff CreateComments become one PostIssueComment each (no batching)", () => {
    const c1 = comment({ id: "c1" });
    const c2 = comment({ id: "c2" });
    const ops: ReconcileOperation[] = [
      { kind: "create-comment", comment: c1 },
      { kind: "create-comment", comment: c2 },
    ];
    const steps = planExecution(ops, context({ isInDiff: () => false }));
    expect(steps).toEqual([
      { kind: "post-issue-comment", comment: c1 },
      { kind: "post-issue-comment", comment: c2 },
    ]);
  });

  test("mixed in/out-of-diff splits cleanly: one PostReviewBatch + N PostIssueComments", () => {
    const inDiff1 = comment({ id: "in1", path: "in.md" });
    const inDiff2 = comment({ id: "in2", path: "in.md" });
    const out1 = comment({ id: "out1", path: "out.md" });
    const ops: ReconcileOperation[] = [
      { kind: "create-comment", comment: inDiff1 },
      { kind: "create-comment", comment: out1 },
      { kind: "create-comment", comment: inDiff2 },
    ];
    const steps = planExecution(ops, context({ isInDiff: (c) => c.path === "in.md" }));
    expect(steps).toEqual([
      {
        kind: "post-review-batch",
        commitId: "current-head",
        comments: [inDiff1, inDiff2],
      },
      { kind: "post-issue-comment", comment: out1 },
    ]);
  });
});

describe("planner — CreateReply", () => {
  test("a reply to an in-diff parent maps 1:1 to PostReply (never batched)", () => {
    const parent = comment({ id: "p", state: "synced", remoteId: 10 });
    const r1 = comment({ id: "r1", parentLocalId: "p" });
    const r2 = comment({ id: "r2", parentLocalId: "p" });
    const ops: ReconcileOperation[] = [
      { kind: "create-reply", comment: r1, parent },
      { kind: "create-reply", comment: r2, parent },
    ];
    const steps = planExecution(ops, context({ isInDiff: () => true }));
    expect(steps).toEqual([
      { kind: "post-reply", comment: r1, parent },
      { kind: "post-reply", comment: r2, parent },
    ]);
  });

  test("a reply to an out-of-diff parent becomes a PostIssueComment (issue #184)", () => {
    // The parent was posted as an issue comment; issue comments are flat,
    // so the reply must post as another issue comment, not via the
    // review-reply endpoint (which would 404 on the issue-comment id).
    const parent = comment({ id: "p", state: "synced", remoteId: 10 });
    const reply = comment({ id: "r1", parentLocalId: "p" });
    const ops: ReconcileOperation[] = [{ kind: "create-reply", comment: reply, parent }];
    const steps = planExecution(ops, context({ isInDiff: () => false }));
    expect(steps).toEqual([{ kind: "post-issue-comment", comment: reply }]);
  });

  test("replies route per parent: in-diff → PostReply, out-of-diff → PostIssueComment", () => {
    const inParent = comment({ id: "pin", state: "synced", remoteId: 1, path: "in.md" });
    const outParent = comment({ id: "pout", state: "synced", remoteId: 2, path: "out.md" });
    const inReply = comment({ id: "rin", parentLocalId: "pin", path: "in.md" });
    const outReply = comment({ id: "rout", parentLocalId: "pout", path: "out.md" });
    const ops: ReconcileOperation[] = [
      { kind: "create-reply", comment: inReply, parent: inParent },
      { kind: "create-reply", comment: outReply, parent: outParent },
    ];
    const steps = planExecution(ops, context({ isInDiff: (c) => c.path === "in.md" }));
    expect(steps).toEqual([
      { kind: "post-issue-comment", comment: outReply },
      { kind: "post-reply", comment: inReply, parent: inParent },
    ]);
  });
});

describe("planner — UpdateThreadResolved", () => {
  test("desiredResolved=true → ResolveReviewThread", () => {
    const ops: ReconcileOperation[] = [
      {
        kind: "update-thread-resolved",
        threadId: "t1",
        remoteThreadId: "PRT_a",
        desiredResolved: true,
      },
    ];
    expect(planExecution(ops, context())).toEqual([
      {
        kind: "resolve-review-thread",
        threadId: "t1",
        remoteThreadId: "PRT_a",
      },
    ]);
  });

  test("desiredResolved=false → UnresolveReviewThread", () => {
    const ops: ReconcileOperation[] = [
      {
        kind: "update-thread-resolved",
        threadId: "t1",
        remoteThreadId: "PRT_a",
        desiredResolved: false,
      },
    ];
    expect(planExecution(ops, context())).toEqual([
      {
        kind: "unresolve-review-thread",
        threadId: "t1",
        remoteThreadId: "PRT_a",
      },
    ]);
  });
});

describe("planner — CommitFileEdit", () => {
  test("a single CommitFileEdit becomes one CommitStep", () => {
    const fe = fileEdit();
    const ops: ReconcileOperation[] = [{ kind: "commit-file-edit", fileEdit: fe }];
    const steps = planExecution(ops, context({ headSha: "h", headRef: "topic" }));
    expect(steps).toEqual([
      {
        kind: "commit",
        baseSha: "h",
        headRef: "topic",
        fileEdits: [fe],
      },
    ]);
  });

  test("multiple CommitFileEdits bundle into one CommitStep", () => {
    const f1 = fileEdit({ id: "f1", path: "a.md" });
    const f2 = fileEdit({ id: "f2", path: "b.md" });
    const f3 = fileEdit({ id: "f3", path: "c.md" });
    const ops: ReconcileOperation[] = [
      { kind: "commit-file-edit", fileEdit: f1 },
      { kind: "commit-file-edit", fileEdit: f2 },
      { kind: "commit-file-edit", fileEdit: f3 },
    ];
    const steps = planExecution(ops, context());
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: "commit",
      fileEdits: [f1, f2, f3],
    });
  });
});

describe("planner — mixed", () => {
  test("all Op kinds in one cycle produce the expected Step list", () => {
    const c = comment({ id: "c-new" });
    const parent = comment({ id: "p", state: "synced", remoteId: 50 });
    const r = comment({ id: "r", parentLocalId: "p" });
    const fe = fileEdit({ id: "f" });
    const ops: ReconcileOperation[] = [
      { kind: "create-comment", comment: c },
      { kind: "create-reply", comment: r, parent },
      {
        kind: "update-thread-resolved",
        threadId: "t-other",
        remoteThreadId: "PRT_b",
        desiredResolved: true,
      },
      { kind: "commit-file-edit", fileEdit: fe },
    ];
    const steps = planExecution(ops, context());
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({ kind: "post-review-batch", comments: [c] });
    expect(steps[1]).toMatchObject({ kind: "post-reply", comment: r, parent });
    expect(steps[2]).toMatchObject({
      kind: "resolve-review-thread",
      threadId: "t-other",
    });
    expect(steps[3]).toMatchObject({ kind: "commit", fileEdits: [fe] });
  });
});
