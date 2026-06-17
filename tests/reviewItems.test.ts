// Unified review-items model (sidebar).
//
// Threads group submitted comments AND pending drafts by thread id, so a reply
// to a comment (a pending draft with the same thread id) shows nested in the
// same thread instead of as a separate item. Live suggestions are their own
// pending entries. A header filter narrows to all / pending / submitted.
import { describe, expect, test } from "bun:test";
import {
  buildThreads,
  buildReviewEntries,
  buildPendingItems,
  buildPendingSuggestions,
  filterReviewEntries,
  reviewCounts,
  threadRangeAt,
  type PendingSuggestion,
  type ThreadRange,
} from "../entrypoints/review/reviewItems";
import type { ExistingComment } from "../lib/comments";
import type { PendingDraft } from "../lib/drafts";
import type { SuggestionHunk } from "../lib/suggest";

function comment(over: Partial<ExistingComment> & { id: number }): ExistingComment {
  return {
    source: "review",
    author: "alice",
    body: "body",
    meta: null,
    ...over,
  };
}

function meta(sl: number, path = "a.md", thread = `t${sl}`) {
  return {
    cid: `c${sl}`,
    path,
    range: { sl, sc: 1, el: sl, ec: 5 },
    quote: `quote ${sl}`,
    sha: "sha",
    thread,
    kind: "comment" as const,
  };
}

function draft(over: Partial<PendingDraft> & { cid: string }): PendingDraft {
  return {
    path: "a.md",
    inDiff: true,
    range: { sl: 1, sc: 1, el: 1, ec: 5 },
    quote: "q",
    sha: "sha",
    thread: over.cid,
    body: "draft body",
    kind: "comment",
    ...over,
  };
}

const liveSuggestion: PendingSuggestion = {
  cid: "live:3:3",
  path: "a.md",
  inDiff: true,
  range: { sl: 3, sc: 1, el: 3, ec: 1 },
  quote: "old",
  replacement: "new",
  body: "",
};

describe("buildThreads", () => {
  test("merges a submitted comment and a pending reply with the same thread id", () => {
    const comments = [comment({ id: 1, meta: meta(5, "a.md", "t1") })];
    const drafts = [draft({ cid: "d1", thread: "t1", range: { sl: 5, sc: 1, el: 5, ec: 5 } })];
    const threads = buildThreads(comments, drafts, "a.md");
    expect(threads).toHaveLength(1);
    const t = threads[0];
    expect(t.messages.map((m) => m.kind)).toEqual(["submitted", "pending"]);
    expect(t.hasSubmitted).toBe(true);
    expect(t.hasPending).toBe(true);
    expect(t.rootComment?.id).toBe(1);
  });

  test("a brand-new pending comment is its own thread; replies group, not split", () => {
    const drafts = [
      draft({ cid: "d1", thread: "th", range: { sl: 5, sc: 1, el: 5, ec: 5 }, body: "first" }),
      draft({ cid: "d2", thread: "th", range: { sl: 5, sc: 1, el: 5, ec: 5 }, body: "reply" }),
      draft({ cid: "d3", thread: "other", range: { sl: 9, sc: 1, el: 9, ec: 5 } }),
    ];
    const threads = buildThreads([], drafts, "a.md");
    expect(threads).toHaveLength(2);
    const th = threads.find((t) => t.id === "th")!;
    expect(th.messages.map((m) => m.kind)).toEqual(["pending", "pending"]);
    expect(th.hasSubmitted).toBe(false);
    expect(th.rootDraft?.cid).toBe("d1");
  });

  test("sorts current path first then by position", () => {
    const comments = [
      comment({ id: 1, meta: meta(20, "b.md", "tb") }),
      comment({ id: 2, meta: meta(8, "a.md", "ta") }),
    ];
    const threads = buildThreads(comments, [], "a.md");
    expect(threads.map((t) => t.path)).toEqual(["a.md", "b.md"]);
  });
});

describe("buildReviewEntries / filter", () => {
  const comments = [comment({ id: 1, meta: meta(5, "a.md", "t1") })];
  const drafts = [
    draft({ cid: "d1", thread: "t1", range: { sl: 5, sc: 1, el: 5, ec: 5 } }), // reply to submitted
    draft({ cid: "d2", thread: "new", range: { sl: 9, sc: 1, el: 9, ec: 5 } }), // new pending comment
  ];
  const threads = buildThreads(comments, drafts, "a.md");
  const entries = buildReviewEntries({
    threads,
    pendingSuggestions: [liveSuggestion],
    currentPath: "a.md",
  });

  test("entries are threads + live suggestions, position sorted", () => {
    // a.md: live (L3), thread t1 (L5), thread new (L9)
    const kinds = entries.map((e) =>
      e.kind === "thread" ? `thread:${e.thread.id}` : `live:${e.suggestion.cid}`,
    );
    expect(kinds).toEqual(["live:live:3:3", "thread:t1", "thread:new"]);
  });

  test("'pending' shows threads with pending content + live suggestions", () => {
    const pending = filterReviewEntries(entries, "pending");
    // t1 (has pending reply), new (pending), live → 3
    expect(pending).toHaveLength(3);
  });

  test("'submitted' shows only threads that have submitted comments", () => {
    const submitted = filterReviewEntries(entries, "submitted");
    expect(submitted).toHaveLength(1);
    expect(submitted[0].kind === "thread" && submitted[0].thread.id).toBe("t1");
  });

  test("'all' shows everything", () => {
    expect(filterReviewEntries(entries, "all")).toHaveLength(3);
  });
});

describe("reviewCounts", () => {
  const comments = [comment({ id: 1, meta: meta(5) }), comment({ id: 2, meta: meta(6) })];
  const drafts = [draft({ cid: "d1" })];
  const threads = buildThreads(comments, drafts, "a.md");

  test("pending = drafts + live suggestions; submitted = submitted comments", () => {
    const counts = reviewCounts({
      drafts,
      pendingSuggestions: [liveSuggestion],
      comments,
      threads,
    });
    expect(counts.pending).toBe(2); // 1 draft + 1 live suggestion
    expect(counts.submitted).toBe(2); // 2 submitted comments
    expect(counts.all).toBe(threads.length + 1);
  });
});

describe("buildPendingItems", () => {
  test("flattens drafts and live suggestions into submittable items", () => {
    const drafts = [draft({ cid: "d1" }), draft({ cid: "d2" })];
    const items = buildPendingItems(drafts, [liveSuggestion]);
    expect(items).toHaveLength(3);
    expect(items.filter((i) => i.kind === "comment")).toHaveLength(2);
    expect(items.filter((i) => i.kind === "suggestion")).toHaveLength(1);
  });
});

describe("threadRangeAt", () => {
  // Click an offset in the body → which commented thread to emphasize.
  const ranges: ThreadRange[] = [
    { id: "outer", from: 0, to: 20 },
    { id: "inner", from: 5, to: 10 },
    { id: "other", from: 30, to: 40 },
  ];

  test("returns the narrowest range containing the offset (nested comments)", () => {
    expect(threadRangeAt(ranges, 7)?.id).toBe("inner");
    expect(threadRangeAt(ranges, 2)?.id).toBe("outer");
  });

  test("range boundaries are inclusive", () => {
    expect(threadRangeAt(ranges, 0)?.id).toBe("outer");
    expect(threadRangeAt(ranges, 40)?.id).toBe("other");
  });

  test("returns null when no range contains the offset", () => {
    expect(threadRangeAt(ranges, 25)).toBeNull();
  });
});

describe("buildPendingSuggestions", () => {
  const hunks: SuggestionHunk[] = [
    { sl: 3, el: 3, replacement: "new3", quote: "old3" },
    { sl: 7, el: 8, replacement: "new78", quote: "old7\nold8" },
  ];

  test("carries a per-hunk comment and a stable live cid, with diff routing", () => {
    const comments: Record<string, string> = { "live:3:3": "fix this", "live:7:8": "" };
    const out = buildPendingSuggestions(hunks, {
      path: "a.md",
      isInDiff: (sl) => sl < 5,
      commentFor: (cid) => comments[cid] ?? "",
    });
    expect(out.map((s) => s.cid)).toEqual(["live:3:3", "live:7:8"]);
    expect(out[0].body).toBe("fix this");
    expect(out[1].body).toBe("");
    expect(out[0].inDiff).toBe(true);
    expect(out[1].inDiff).toBe(false);
    expect(out[0].replacement).toBe("new3");
    expect(out[1].range).toEqual({ sl: 7, sc: 1, el: 8, ec: 1 });
  });
});
