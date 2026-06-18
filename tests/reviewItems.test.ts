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
  buildAllPendingSuggestions,
  buildPendingItems,
  groupPendingByFile,
  buildPendingSuggestions,
  buildSuggestionMarks,
  filterReviewEntries,
  reviewEntryCounts,
  summarizePending,
  threadRangeAt,
  type PendingSuggestion,
  type ThreadRange,
} from "../entrypoints/review/reviewItems";
import type { SuggestionEdit } from "../lib/drafts";
import { buildLineIndex } from "../lib/anchor";
import type { ExistingComment } from "../lib/comments";
import type { PendingDraft } from "../lib/drafts";
import type { CommentMetadata } from "../lib/metadata";
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

describe("summarizePending", () => {
  test("empty", () => {
    expect(summarizePending([])).toEqual({
      total: 0,
      review: { comments: 0, suggestions: 0, total: 0 },
      direct: { comments: 0, suggestions: 0, total: 0 },
    });
  });

  test("splits in-diff (review) from out-of-diff (direct), and comments from suggestions", () => {
    const items = buildPendingItems(
      [
        draft({ cid: "c1", inDiff: true, kind: "comment" }),
        draft({ cid: "c2", inDiff: true, kind: "suggestion", suggestion: "x" }),
        draft({ cid: "c3", inDiff: false, kind: "comment" }),
      ],
      [liveSuggestion], // inDiff suggestion
    );
    const s = summarizePending(items);
    expect(s.total).toBe(4);
    expect(s.review).toEqual({ comments: 1, suggestions: 2, total: 3 });
    expect(s.direct).toEqual({ comments: 1, suggestions: 0, total: 1 });
  });
});

describe("buildSuggestionMarks", () => {
  const source = "line one\nline two\nline three\n";
  const lineStarts = buildLineIndex(source);
  function suggestionComment(over: Partial<CommentMetadata> = {}): ExistingComment {
    return {
      id: 1,
      source: "review",
      author: "x",
      body: "please apply\n\n```suggestion\nLINE TWO\n```",
      meta: {
        cid: "c1",
        path: "a.md",
        range: { sl: 2, sc: 1, el: 2, ec: 1 }, // line-based: collapses to zero width
        quote: "line two",
        sha: "HEAD",
        thread: "t1",
        kind: "suggestion",
        ...over,
      },
    };
  }

  test("renders a single-line submitted suggestion (regression: was zero-width)", () => {
    const marks = buildSuggestionMarks({
      comments: [suggestionComment()],
      source,
      lineStarts,
      headSha: "HEAD", // sha matches → previously used the collapsed line range
      currentPath: "a.md",
      dismissed: {},
    });
    expect(marks).toHaveLength(1);
    expect(marks[0].to).toBeGreaterThan(marks[0].from);
    expect(source.slice(marks[0].from, marks[0].to)).toBe("line two");
    expect(marks[0].replacement).toBe("LINE TWO");
  });

  test("skips non-suggestion comments, other files, and dismissed suggestions", () => {
    const marks = buildSuggestionMarks({
      comments: [suggestionComment({ path: "other.md" }), suggestionComment()],
      source,
      lineStarts,
      headSha: "HEAD",
      currentPath: "a.md",
      dismissed: { "1": "accepted" },
    });
    expect(marks).toHaveLength(0);
  });
});

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
    const pending = filterReviewEntries(entries, new Set(["pending"] as const));
    expect(pending).toHaveLength(3); // t1 (pending reply) + new (pending) + live
  });

  test("'submitted' shows only threads that have submitted comments", () => {
    const submitted = filterReviewEntries(entries, new Set(["submitted"] as const));
    expect(submitted).toHaveLength(1);
    expect(submitted[0].kind === "thread" && submitted[0].thread.id).toBe("t1");
  });

  test("pending+submitted is the union of the two facets", () => {
    expect(filterReviewEntries(entries, new Set(["pending", "submitted"] as const))).toHaveLength(
      3,
    );
  });

  test("excludes items anchored to other files", () => {
    const multi = buildThreads(
      [
        comment({ id: 1, meta: meta(5, "a.md", "ta") }),
        comment({ id: 2, meta: meta(7, "b.md", "tb") }),
      ],
      [],
      "a.md",
    );
    const scoped = buildReviewEntries({
      threads: multi,
      pendingSuggestions: [
        liveSuggestion, // a.md
        { ...liveSuggestion, cid: "live:9:9", path: "b.md", range: { sl: 9, sc: 1, el: 9, ec: 1 } },
      ],
      currentPath: "a.md",
    });
    expect(scoped).toHaveLength(2); // thread ta + a.md live suggestion
    const paths = scoped.map((e) => (e.kind === "thread" ? e.thread.path : e.suggestion.path));
    expect(paths.every((p) => p === "a.md")).toBe(true);
  });
});

describe("reviewEntryCounts", () => {
  test("pending/submitted/resolved derive from the current-file entries", () => {
    const comments = [comment({ id: 1, meta: meta(5, "a.md", "t1") })];
    const drafts = [draft({ cid: "d1", thread: "t1", range: { sl: 5, sc: 1, el: 5, ec: 5 } })];
    const threads = buildThreads(comments, drafts, "a.md");
    const entries = buildReviewEntries({
      threads,
      pendingSuggestions: [liveSuggestion],
      currentPath: "a.md",
    });
    const counts = reviewEntryCounts(entries);
    expect(counts.pending).toBe(2); // t1 pending reply + live suggestion
    expect(counts.submitted).toBe(1); // t1 has a submitted comment
    expect(counts.resolved).toBe(0);
  });

  test("resolved threads count under resolved and drop out of pending/submitted", () => {
    const comments = [
      comment({ id: 1, meta: meta(5, "a.md", "t1") }),
      comment({ id: 2, meta: { ...meta(5, "a.md", "t1"), cid: "e2", event: "resolve" } }),
    ];
    const threads = buildThreads(comments, [], "a.md");
    const entries = buildReviewEntries({ threads, pendingSuggestions: [], currentPath: "a.md" });
    const counts = reviewEntryCounts(entries);
    expect(counts.submitted).toBe(0);
    expect(counts.resolved).toBe(1);
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

describe("groupPendingByFile", () => {
  test("groups items by path (sorted), items by line (submit spans all files)", () => {
    const items = buildPendingItems(
      [
        draft({ cid: "d1", path: "docs/b.md", range: { sl: 9, sc: 1, el: 9, ec: 5 } }),
        draft({ cid: "d2", path: "docs/a.md", range: { sl: 4, sc: 1, el: 4, ec: 5 } }),
        draft({ cid: "d3", path: "docs/a.md", range: { sl: 2, sc: 1, el: 2, ec: 5 } }),
      ],
      [{ ...liveSuggestion, cid: "s1", path: "docs/b.md", range: { sl: 1, sc: 1, el: 1, ec: 1 } }],
    );
    const groups = groupPendingByFile(items);
    expect(groups.map((g) => g.path)).toEqual(["docs/a.md", "docs/b.md"]);
    // a.md items sorted by line: d3 (L2) then d2 (L4)
    expect(groups[0].items.map((i) => (i.kind === "comment" ? i.draft.cid : ""))).toEqual([
      "d3",
      "d2",
    ]);
    // b.md: suggestion (L1) before the draft (L9)
    expect(groups[1].items[0].kind).toBe("suggestion");
    expect(groups[1].items).toHaveLength(2);
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

describe("buildAllPendingSuggestions", () => {
  // Submit scope spans ALL files, so pending suggestions must be gathered from
  // every file's persisted edit — not just the file open in the editor (the bug:
  // comments came from all files but suggestions only from the current one).
  const edits: Record<string, SuggestionEdit> = {
    "docs/b.md": { base: "b1\nb2\nb3\nb4\n", source: "b1\nb2\nb3\nB4\n", comments: {} },
    "docs/a.md": {
      base: "a1\na2\na3\n",
      source: "a1\nA2\na3\n",
      comments: { "live:2:2": "fix a2" },
    },
  };

  test("gathers pending suggestions across every edited file, path-sorted", () => {
    const out = buildAllPendingSuggestions(edits, (path) => path === "docs/a.md");
    expect(out.map((s) => s.path)).toEqual(["docs/a.md", "docs/b.md"]);

    const a = out[0];
    expect(a.cid).toBe("live:2:2");
    expect(a.replacement).toBe("A2");
    expect(a.quote).toBe("a2");
    expect(a.body).toBe("fix a2");
    expect(a.inDiff).toBe(true); // a.md routed in-diff
    expect(a.range).toEqual({ sl: 2, sc: 1, el: 2, ec: 1 });

    const b = out[1];
    expect(b.cid).toBe("live:4:4");
    expect(b.replacement).toBe("B4");
    expect(b.body).toBe(""); // no attached comment
    expect(b.inDiff).toBe(false); // b.md routed out-of-diff
  });

  test("ignores files whose edited source matches the base (no live suggestion)", () => {
    const out = buildAllPendingSuggestions(
      { "docs/a.md": { base: "x\ny\n", source: "x\ny\n", comments: {} } },
      () => true,
    );
    expect(out).toEqual([]);
  });

  test("empty edits map yields no suggestions", () => {
    expect(buildAllPendingSuggestions({}, () => true)).toEqual([]);
  });

  test("skips legacy edits stored before `base` existed (no crash)", () => {
    // Edits persisted by an older build have no `base` field; recomputing their
    // hunks is impossible, so they must be skipped rather than throw.
    const legacy = {
      "docs/a.md": { source: "a1\nA2\na3\n", comments: {} } as unknown as SuggestionEdit,
      "docs/b.md": { base: "b1\nb2\n", source: "b1\nB2\n", comments: {} },
    };
    const out = buildAllPendingSuggestions(legacy, () => true);
    expect(out.map((s) => s.path)).toEqual(["docs/b.md"]);
  });
});

describe("buildThreads resolved state", () => {
  const evt = (id: number, thread: string, event: "resolve" | "unresolve") =>
    comment({ id, meta: { ...meta(5, "a.md", thread), cid: `e${id}`, event } });

  test("a resolve event marks the thread resolved and is not shown as a message", () => {
    const [t] = buildThreads(
      [comment({ id: 1, meta: meta(5, "a.md", "t1") }), evt(2, "t1", "resolve")],
      [],
      "a.md",
    );
    expect(t.resolved).toBe(true);
    expect(t.messages).toHaveLength(1); // only the root, not the event
  });

  test("latest event wins: unresolve after resolve re-opens", () => {
    const [t] = buildThreads(
      [
        comment({ id: 1, meta: meta(5, "a.md", "t1") }),
        evt(2, "t1", "resolve"),
        evt(3, "t1", "unresolve"),
      ],
      [],
      "a.md",
    );
    expect(t.resolved).toBe(false);
  });

  test("an accepted suggestion thread is resolved", () => {
    const [t] = buildThreads(
      [comment({ id: 1, meta: { ...meta(5, "a.md", "t1"), kind: "suggestion" } })],
      [],
      "a.md",
      { accepted: (id) => id === 1 },
    );
    expect(t.resolved).toBe(true);
  });

  test("threads default to not resolved", () => {
    const [t] = buildThreads([comment({ id: 1, meta: meta(5, "a.md", "t1") })], [], "a.md");
    expect(t.resolved).toBe(false);
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
