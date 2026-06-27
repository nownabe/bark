import { describe, expect, test } from "bun:test";
import { commentViewsToExisting } from "../entrypoints/review/adapters/commentViewsToExisting";
import type { CommentView } from "../lib/pr/appstate";
import type { Comment } from "../lib/pr/types";

function makeView(
  comment: Partial<Comment> = {},
  viewOverrides: Partial<CommentView> = {},
): CommentView {
  const c: Comment = {
    id: "c-1",
    state: "synced",
    remoteId: 100,
    threadId: "t-1",
    body: "looks good",
    author: { login: "alice" },
    path: "f.md",
    anchor: {
      sha: "head",
      range: { sl: 5, sc: 1, el: 5, ec: 10 },
      quote: "hello",
    },
    ...comment,
  };
  return {
    comment: c,
    kind: "comment",
    displayPosition: { status: "current", range: c.anchor.range },
    inDiff: true,
    isMyDraft: false,
    ...viewOverrides,
  };
}

describe("commentViewsToExisting — gating", () => {
  test("excludes draft comments (they belong to the pending list)", () => {
    const v = makeView({ state: "draft", remoteId: undefined });
    expect(commentViewsToExisting([v])).toEqual([]);
  });

  test("excludes syncing comments", () => {
    const v = makeView({ state: "syncing" });
    expect(commentViewsToExisting([v])).toEqual([]);
  });

  test("excludes synced comments that have no remoteId (no GitHub identity yet)", () => {
    const v = makeView({ state: "synced", remoteId: undefined });
    expect(commentViewsToExisting([v])).toEqual([]);
  });
});

describe("commentViewsToExisting — Bark-authored", () => {
  test("restores full CommentMetadata from anchor + threadId + parsed kind", () => {
    const v = makeView({
      id: "cid-uuid",
      remoteId: 42,
      threadId: "tid-uuid",
      body: "ok",
      path: "src/foo.md",
      anchor: {
        sha: "abcdef",
        range: { sl: 3, sc: 1, el: 4, ec: 9 },
        quote: "selected",
      },
    });
    const out = commentViewsToExisting([v])[0];
    expect(out).toEqual({
      id: 42,
      source: "review",
      author: "alice",
      body: "ok",
      meta: {
        cid: "cid-uuid",
        path: "src/foo.md",
        range: { sl: 3, sc: 1, el: 4, ec: 9 },
        quote: "selected",
        sha: "abcdef",
        thread: "tid-uuid",
        kind: "comment",
      },
      path: "src/foo.md",
      line: 4,
    });
  });

  test("kind reflects the CommentView kind (suggestion comes through)", () => {
    const v = makeView({}, { kind: "suggestion", replacement: "new line" });
    const out = commentViewsToExisting([v])[0];
    expect(out?.meta?.kind).toBe("suggestion");
  });
});

describe("commentViewsToExisting — foreign", () => {
  test("foreign-review-* → source 'review', meta=null, path/line fallback", () => {
    const v = makeView({
      id: "foreign-review-99",
      remoteId: 99,
      threadId: "foreign-thread-review-99",
      path: "doc.md",
      anchor: { sha: "", range: { sl: 7, sc: 1, el: 7, ec: 1 }, quote: "" },
      author: { login: "carol" },
      body: "Drive-by comment",
    });
    const out = commentViewsToExisting([v])[0];
    expect(out).toEqual({
      id: 99,
      source: "review",
      author: "carol",
      body: "Drive-by comment",
      meta: null,
      path: "doc.md",
      line: 7,
    });
  });

  test("foreign-issue-* → source 'issue', meta=null, no path/line fields", () => {
    const v = makeView({
      id: "foreign-issue-50",
      remoteId: 50,
      threadId: "foreign-thread-issue-50",
      path: "",
      anchor: { sha: "", range: { sl: 1, sc: 1, el: 1, ec: 1 }, quote: "" },
      author: { login: "dan" },
      body: "Top-level chatter",
    });
    const out = commentViewsToExisting([v])[0];
    expect(out).toEqual({
      id: 50,
      source: "issue",
      author: "dan",
      body: "Top-level chatter",
      meta: null,
    });
    expect("path" in (out ?? {})).toBe(false);
    expect("line" in (out ?? {})).toBe(false);
  });
});

describe("commentViewsToExisting — collection order", () => {
  test("preserves the iteration order of the input map / iterable", () => {
    const a = makeView({ id: "a", remoteId: 1 });
    const b = makeView({ id: "b", remoteId: 2 });
    const c = makeView({ id: "c", remoteId: 3 });
    const out = commentViewsToExisting([c, a, b]);
    expect(out.map((x) => x.id)).toEqual([3, 1, 2]);
  });
});
