// Unified review-items model (sidebar) — tasks 2 & 4.
//
// The sidebar must show pending drafts, the reviewer's *live* suggestion edits
// (treated as pending the moment they are made), and already-submitted comment
// threads in a SINGLE list, sorted together by position (current file first).
// A header filter narrows the list to all / pending / submitted.
import { describe, expect, test } from "bun:test";
import {
  buildThreads,
  buildReviewEntries,
  filterReviewEntries,
  reviewCounts,
  type PendingSuggestion,
  type ReviewThread,
} from "../entrypoints/review/reviewItems";
import type { ExistingComment } from "../lib/comments";
import type { PendingDraft } from "../lib/drafts";

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

describe("buildThreads", () => {
  test("groups comments by thread id and sorts current path first then position", () => {
    const comments: ExistingComment[] = [
      comment({ id: 1, meta: meta(20, "b.md", "tb") }),
      comment({ id: 2, meta: meta(5, "a.md", "ta") }),
      comment({ id: 3, meta: meta(5, "a.md", "ta") }), // reply in same thread
      comment({ id: 4, meta: meta(2, "a.md", "ta2") }),
    ];
    const threads = buildThreads(comments, "a.md");
    // current path (a.md) threads come before b.md
    expect(threads.map((t) => t.path)).toEqual(["a.md", "a.md", "b.md"]);
    // within a.md, sorted by position (line 2 before line 5)
    expect(threads[0].root.id).toBe(4);
    expect(threads[1].root.id).toBe(2);
    // the thread for ta has both comments 2 and 3
    expect(threads[1].comments.map((c) => c.id)).toEqual([2, 3]);
  });
});

describe("buildReviewEntries", () => {
  const drafts: PendingDraft[] = [
    draft({ cid: "d1", range: { sl: 10, sc: 1, el: 10, ec: 5 } }),
    draft({ cid: "d2", path: "b.md", range: { sl: 1, sc: 1, el: 1, ec: 5 } }),
  ];
  const suggestions: PendingSuggestion[] = [
    {
      cid: "live:3",
      path: "a.md",
      inDiff: true,
      range: { sl: 3, sc: 1, el: 3, ec: 1 },
      quote: "old line",
      replacement: "new line",
      body: "(suggested edit)",
    },
  ];
  const threads: ReviewThread[] = buildThreads(
    [comment({ id: 1, meta: meta(50, "a.md", "t50") })],
    "a.md",
  );

  test("merges drafts, live suggestions and submitted threads, tagged with status", () => {
    const entries = buildReviewEntries({
      drafts,
      threads,
      pendingSuggestions: suggestions,
      currentPath: "a.md",
    });
    const byKind = entries.map((e) => e.kind);
    expect(byKind).toContain("draft");
    expect(byKind).toContain("liveSuggestion");
    expect(byKind).toContain("thread");
    const liveEntry = entries.find((e) => e.kind === "liveSuggestion")!;
    expect(liveEntry.status).toBe("pending");
    const threadEntry = entries.find((e) => e.kind === "thread")!;
    expect(threadEntry.status).toBe("submitted");
  });

  test("sorts current path first, then by position, across pending and submitted", () => {
    const entries = buildReviewEntries({
      drafts,
      threads,
      pendingSuggestions: suggestions,
      currentPath: "a.md",
    });
    // a.md entries: live suggestion (L3), draft d1 (L10), thread (L50); then b.md draft d2
    const ids = entries.map((e) => {
      if (e.kind === "draft") return e.draft.cid;
      if (e.kind === "liveSuggestion") return e.suggestion.cid;
      return `thread:${e.thread.root.id}`;
    });
    expect(ids).toEqual(["live:3", "d1", "thread:1", "d2"]);
  });
});

describe("filterReviewEntries & reviewCounts", () => {
  const drafts: PendingDraft[] = [draft({ cid: "d1" })];
  const suggestions: PendingSuggestion[] = [
    {
      cid: "live:3",
      path: "a.md",
      inDiff: true,
      range: { sl: 3, sc: 1, el: 3, ec: 1 },
      quote: "old",
      replacement: "new",
      body: "(suggested edit)",
    },
  ];
  const threads = buildThreads([comment({ id: 1, meta: meta(50) })], "a.md");
  const entries = buildReviewEntries({
    drafts,
    threads,
    pendingSuggestions: suggestions,
    currentPath: "a.md",
  });

  test("filter 'all' returns everything", () => {
    expect(filterReviewEntries(entries, "all").length).toBe(3);
  });

  test("filter 'pending' returns drafts and live suggestions only", () => {
    const pending = filterReviewEntries(entries, "pending");
    expect(pending.length).toBe(2);
    expect(pending.every((e) => e.status === "pending")).toBe(true);
  });

  test("filter 'submitted' returns threads only", () => {
    const submitted = filterReviewEntries(entries, "submitted");
    expect(submitted.length).toBe(1);
    expect(submitted.every((e) => e.status === "submitted")).toBe(true);
  });

  test("reviewCounts reports pending (drafts + live suggestions) and submitted totals", () => {
    const counts = reviewCounts(entries);
    expect(counts.pending).toBe(2);
    expect(counts.submitted).toBe(1);
    expect(counts.all).toBe(3);
  });
});
