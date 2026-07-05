import { describe, expect, test } from "bun:test";
import { threadKeysForThreadIds } from "../entrypoints/review/threadKeys";
import type { CommentView } from "../lib/pr/appstate";
import type { Comment } from "../lib/pr/types";

function view(over: Partial<Comment> & { id: string; threadId: string }): CommentView {
  const comment: Comment = {
    state: "synced",
    body: "b",
    author: { login: "x" },
    path: "f.md",
    anchor: { sha: "s", range: { sl: 1, sc: 1, el: 1, ec: 2 }, quote: "q" },
    ...over,
  };
  return {
    comment,
    kind: "comment",
    displayPosition: { status: "current", range: comment.anchor.range },
    inDiff: true,
    isMyDraft: comment.state === "draft",
  };
}

describe("threadKeysForThreadIds", () => {
  test("returns empty for an empty thread-id set (no scan)", () => {
    const out = threadKeysForThreadIds([view({ id: "c1", threadId: "t1" })], new Set());
    expect(out.size).toBe(0);
  });

  test("Bark comment keys by its cid (== Thread.id)", () => {
    const views = [
      view({ id: "c1", threadId: "t1", remoteId: 10 }),
      view({ id: "c2", threadId: "t2", remoteId: 11 }),
    ];
    const out = threadKeysForThreadIds(views, new Set(["t1"]));
    expect([...out]).toEqual(["c1"]);
  });

  test("foreign review comments key by solo:review:<remoteId>", () => {
    const views = [
      view({ id: "foreign-review-55", threadId: "foreign-thread-PRT_a", remoteId: 55 }),
      view({ id: "foreign-review-56", threadId: "foreign-thread-PRT_a", remoteId: 56 }),
    ];
    const out = threadKeysForThreadIds(views, new Set(["foreign-thread-PRT_a"]));
    expect(out).toEqual(new Set(["solo:review:55", "solo:review:56"]));
  });

  test("foreign issue comments key by solo:issue:<remoteId>", () => {
    const views = [
      view({ id: "foreign-issue-7", threadId: "foreign-thread-issue-7", remoteId: 7 }),
    ];
    const out = threadKeysForThreadIds(views, new Set(["foreign-thread-issue-7"]));
    expect(out).toEqual(new Set(["solo:issue:7"]));
  });

  test("skips foreign comments that have no remoteId", () => {
    const views = [view({ id: "foreign-review-9", threadId: "foreign-thread-PRT_b" })];
    const out = threadKeysForThreadIds(views, new Set(["foreign-thread-PRT_b"]));
    expect(out.size).toBe(0);
  });

  test("ignores comments whose threadId is not in the set", () => {
    const views = [view({ id: "c1", threadId: "t1" }), view({ id: "c2", threadId: "t2" })];
    const out = threadKeysForThreadIds(views, new Set(["t2"]));
    expect([...out]).toEqual(["c2"]);
  });
});
