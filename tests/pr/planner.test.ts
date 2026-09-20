import { describe, expect, test } from "bun:test";
import type { ReconcileOperation } from "../../lib/pr/operations";
import { planExecution, type PlannerContext } from "../../lib/pr/planner";
import type { Comment, FileEdit, PullRequest } from "../../lib/pr/types";

const author = { login: "alice" };
// Anchored at the planner's head sha: comments at an older sha are
// re-anchored (or refused) before planning — see the repository tests
// for issue #265.
const anchor = {
  sha: "current-head",
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

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    owner: "o",
    repo: "r",
    number: 7,
    title: "t",
    body: "",
    headSha: "current-head",
    headRef: "topic",
    headRepo: { owner: "o", repo: "r" },
    baseRef: "main",
    state: "open",
    draft: false,
    merged: false,
    author,
    ...overrides,
  };
}

function context(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    isInDiff: () => true,
    headSha: "current-head",
    headRef: "topic",
    headRepo: { owner: "o", repo: "r" },
    fileContents: [],
    pullRequest: pullRequest(),
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

  // Issue #279: GitHub caps a comment body at 65,536 characters and a review
  // batch is atomic, so one oversized comment used to fail every other comment
  // in the same submit.
  test("a comment whose wire body exceeds GitHub's limit is rejected, the rest of the batch posts", () => {
    const small = comment({ id: "small" });
    const huge = comment({ id: "huge", body: "x".repeat(70_000) });
    const steps = planExecution(
      [
        { kind: "create-comment", comment: small },
        { kind: "create-comment", comment: huge },
      ],
      context(),
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({
      kind: "post-review-batch",
      commitId: "current-head",
      comments: [small],
    });
    expect(steps[1]).toMatchObject({ kind: "reject-comment", comment: huge });
    expect((steps[1] as { error: { message: string } }).error.message).toContain("too large");
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

// Issue #313: the submit path already routes every draft through the same
// `reanchor` as display; what it owed was a policy for `shifted`. Posting a
// draft whose quoted text changed upstream would attach the reviewer's words
// (and an applicable suggestion) to text they never saw — ADR 0003 §5 refuses.
describe("planner — submit-time re-anchoring policy (issue #313)", () => {
  const staleContext = (headSource: string, oldSource: string) =>
    context({
      fileContents: [
        { sha: "old", path: "README.md", source: oldSource },
        { sha: "current-head", path: "README.md", source: headSource },
      ],
    });

  test("a draft whose quoted text changed upstream (shifted) is refused", () => {
    const c = comment({
      anchor: { sha: "old", range: { sl: 2, sc: 1, el: 2, ec: 12 }, quote: "hello world" },
    });
    const steps = planExecution(
      [{ kind: "create-comment", comment: c }],
      staleContext("a\nhello WORLD\nb", "a\nhello world\nb"),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "reject-comment", comment: c });
    expect((steps[0] as { error: { message: string } }).error.message).toContain(
      "position shifted",
    );
  });

  test("a draft whose paragraph changed elsewhere (mapped by the region search) posts at the located columns", () => {
    const c = comment({
      anchor: { sha: "old", range: { sl: 2, sc: 6, el: 2, ec: 10 }, quote: "Two." },
    });
    const steps = planExecution(
      [{ kind: "create-comment", comment: c }],
      staleContext("a\nOne. Two. THREE.\nb", "a\nOne. Two.\nb"),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: "post-review-batch",
      comments: [
        {
          anchor: {
            sha: "current-head",
            range: { sl: 2, sc: 6, el: 2, ec: 10 },
            quote: "Two.",
          },
        },
      ],
    });
  });

  test("a draft whose line is gone is refused with the outdated message, not the shifted one", () => {
    const c = comment({
      anchor: { sha: "old", range: { sl: 2, sc: 1, el: 2, ec: 12 }, quote: "doomed line" },
    });
    const steps = planExecution(
      [{ kind: "create-comment", comment: c }],
      staleContext("a\nb", "a\ndoomed line\nb"),
    );
    expect(steps).toHaveLength(1);
    const error = (steps[0] as { error: { message: string } }).error.message;
    expect(error).toContain("Could not map the commented lines");
    expect(error).not.toContain("position shifted");
  });
});

describe("planner — CreateReply", () => {
  test("a reply to a review-comment parent maps 1:1 to PostReply (never batched)", () => {
    const parent = comment({ id: "p", state: "synced", remoteId: 10, remoteKind: "review" });
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

  test("a reply to an issue-comment parent is a PostIssueComment even when the parent's lines are in the current diff", () => {
    // Issue comments are flat and their REST id is not a review-comment id,
    // so the review-reply endpoint would 404 — regardless of whether the
    // parent's creation-time lines happen to sit in today's diff (#285).
    const parent = comment({ id: "p", state: "synced", remoteId: 10, remoteKind: "issue" });
    const reply = comment({ id: "r1", parentLocalId: "p" });
    const ops: ReconcileOperation[] = [{ kind: "create-reply", comment: reply, parent }];
    const steps = planExecution(ops, context({ isInDiff: () => true }));
    expect(steps).toEqual([{ kind: "post-issue-comment", comment: reply }]);
  });

  test("a reply to a review-comment parent is a PostReply even when the parent's lines left the diff", () => {
    const parent = comment({ id: "p", state: "synced", remoteId: 10, remoteKind: "review" });
    const reply = comment({ id: "r1", parentLocalId: "p" });
    const ops: ReconcileOperation[] = [{ kind: "create-reply", comment: reply, parent }];
    const steps = planExecution(ops, context({ isInDiff: () => false }));
    expect(steps).toEqual([{ kind: "post-reply", comment: reply, parent }]);
  });

  test("a parent without remoteKind (legacy LocalState) falls back to the diff heuristic", () => {
    const parent = comment({ id: "p", state: "synced", remoteId: 10 });
    const reply = comment({ id: "r1", parentLocalId: "p" });
    const ops: ReconcileOperation[] = [{ kind: "create-reply", comment: reply, parent }];
    expect(planExecution(ops, context({ isInDiff: () => false }))).toEqual([
      { kind: "post-issue-comment", comment: reply },
    ]);
    expect(planExecution(ops, context({ isInDiff: () => true }))).toEqual([
      { kind: "post-reply", comment: reply, parent },
    ]);
  });

  test("replies route per parent: review parent → PostReply, issue parent → PostIssueComment", () => {
    const inParent = comment({
      id: "pin",
      state: "synced",
      remoteId: 1,
      remoteKind: "review",
      path: "in.md",
    });
    const outParent = comment({
      id: "pout",
      state: "synced",
      remoteId: 2,
      remoteKind: "issue",
      path: "out.md",
    });
    const inReply = comment({ id: "rin", parentLocalId: "pin", path: "in.md" });
    const outReply = comment({ id: "rout", parentLocalId: "pout", path: "out.md" });
    const ops: ReconcileOperation[] = [
      { kind: "create-reply", comment: inReply, parent: inParent },
      { kind: "create-reply", comment: outReply, parent: outParent },
    ];
    const steps = planExecution(ops, context({ isInDiff: () => true }));
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

  test("an op carrying remoteIssueCommentId → SetIssueThreadResolved (issue #270)", () => {
    const op = (desiredResolved: boolean): ReconcileOperation => ({
      kind: "update-thread-resolved",
      threadId: "t-out",
      remoteIssueCommentId: 501,
      desiredResolved,
    });
    expect(planExecution([op(true)], context())).toEqual([
      { kind: "set-issue-thread-resolved", threadId: "t-out", issueCommentId: 501, resolved: true },
    ]);
    expect(planExecution([op(false)], context())).toEqual([
      {
        kind: "set-issue-thread-resolved",
        threadId: "t-out",
        issueCommentId: 501,
        resolved: false,
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
        headRepo: { owner: "o", repo: "r" },
        fileEdits: [fe],
      },
    ]);
  });

  test("a CommitStep carries the context's headRepo (issue #273)", () => {
    const ops: ReconcileOperation[] = [{ kind: "commit-file-edit", fileEdit: fileEdit() }];
    const steps = planExecution(ops, context({ headRepo: { owner: "forker", repo: "r-fork" } }));
    expect(steps[0]).toMatchObject({ headRepo: { owner: "forker", repo: "r-fork" } });
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

  test("a merged PR gets no CommitStep — the edits are refused instead (#288)", () => {
    const fe = fileEdit();
    const ops: ReconcileOperation[] = [{ kind: "commit-file-edit", fileEdit: fe }];
    const steps = planExecution(ops, context({ pullRequest: pullRequest({ merged: true }) }));
    expect(steps.some((s) => s.kind === "commit")).toBe(false);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "reject-commit", fileEdits: [fe] });
    expect((steps[0] as { error: { message: string } }).error.message).toContain("merged");
  });

  test("a closed PR gets no CommitStep — the edits are refused instead (#288)", () => {
    const fe = fileEdit();
    const ops: ReconcileOperation[] = [{ kind: "commit-file-edit", fileEdit: fe }];
    const steps = planExecution(ops, context({ pullRequest: pullRequest({ state: "closed" }) }));
    expect(steps[0]).toMatchObject({ kind: "reject-commit", fileEdits: [fe] });
    expect((steps[0] as { error: { message: string } }).error.message).toContain("closed");
  });

  test("comments still go out on a merged PR — only the commit is refused (#288)", () => {
    const c = comment({ id: "c-new" });
    const ops: ReconcileOperation[] = [
      { kind: "create-comment", comment: c },
      { kind: "commit-file-edit", fileEdit: fileEdit() },
    ];
    const steps = planExecution(ops, context({ pullRequest: pullRequest({ merged: true }) }));
    expect(steps[0]).toMatchObject({ kind: "post-review-batch", comments: [c] });
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
