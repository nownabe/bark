// Unified review-items model (sidebar).
//
// Threads group submitted comments AND pending drafts by thread id, so a reply
// to a comment (a pending draft with the same thread id) shows nested in the
// same thread instead of as a separate item. Live suggestions are their own
// pending entries. A header filter narrows to all / pending / submitted.
import { describe, expect, test } from "bun:test";
import {
  buildAuthorPendingItems,
  buildThreads,
  buildReviewEntries,
  buildAllPendingSuggestions,
  buildPendingItems,
  groupPendingByFile,
  buildPendingSuggestions,
  buildSuggestionMarks,
  canReplyToThread,
  deriveRole,
  filterReviewEntries,
  revealSubmittedFacets,
  reviewEntryCounts,
  summarizePending,
  threadRangeAt,
  sortPos,
  composerInsertIndex,
  type AcceptedSuggestionInfo,
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
      commit: { editedFiles: 0, acceptances: 0 },
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
  // The new layer's CommentView.displayPosition is what App.tsx feeds in.
  // For these tests, anchors live at the current head, so the position
  // mirrors the anchor's own range.
  const dpFromAnchor = (comments: ExistingComment[]) => {
    const byCid = new Map<string, { sl: number; sc: number; el: number; ec: number }>();
    for (const c of comments) {
      if (c.meta) byCid.set(c.meta.cid, c.meta.range);
    }
    return (cid: string) => {
      const range = byCid.get(cid);
      return range ? { status: "current" as const, range } : null;
    };
  };

  test("renders a single-line submitted suggestion (regression: was zero-width)", () => {
    const comments = [suggestionComment()];
    const marks = buildSuggestionMarks({
      comments,
      source,
      lineStarts,
      currentPath: "a.md",
      dismissed: {},
      displayPositionFor: dpFromAnchor(comments),
    });
    expect(marks).toHaveLength(1);
    expect(marks[0].to).toBeGreaterThan(marks[0].from);
    expect(source.slice(marks[0].from, marks[0].to)).toBe("line two");
    expect(marks[0].replacement).toBe("LINE TWO");
  });

  test("skips non-suggestion comments, other files, and dismissed suggestions", () => {
    const comments = [suggestionComment({ path: "other.md" }), suggestionComment()];
    const marks = buildSuggestionMarks({
      comments,
      source,
      lineStarts,
      currentPath: "a.md",
      dismissed: { "1": "accepted" },
      displayPositionFor: dpFromAnchor(comments),
    });
    expect(marks).toHaveLength(0);
  });

  test("skips suggestions whose thread has a 'resolve' event (regression)", () => {
    // After Submit, the local dismissed map is cleared but the resolve-event
    // metadata comment is persisted on GitHub. The overlay must also consult
    // that event — otherwise the strikethrough + replacement keep showing in
    // the editor even though the sidebar treats the thread as resolved.
    const resolveEvent: ExistingComment = {
      id: 2,
      source: "review",
      author: "x",
      body: "Resolved via Bark.",
      meta: {
        cid: "e2",
        path: "a.md",
        range: { sl: 2, sc: 1, el: 2, ec: 1 },
        quote: "line two",
        sha: "HEAD",
        thread: "t1",
        kind: "comment",
        event: "resolve",
      },
    };
    const comments = [suggestionComment(), resolveEvent];
    const marks = buildSuggestionMarks({
      comments,
      source,
      lineStarts,
      currentPath: "a.md",
      dismissed: {},
      displayPositionFor: dpFromAnchor(comments),
    });
    expect(marks).toHaveLength(0);
  });

  test("skips the mark when the target text no longer matches the quote (issue #176)", () => {
    // The target line changed since the suggestion was written ("shifted"
    // position). Sizing the strikethrough by quote.length there would
    // overlay the wrong text — the mark must be skipped instead.
    const altered = "line one\nline 2!!\nline three\n";
    const comments = [suggestionComment({ sha: "OLD" })]; // quote: "line two"
    const marks = buildSuggestionMarks({
      comments,
      source: altered,
      lineStarts: buildLineIndex(altered),
      currentPath: "a.md",
      dismissed: {},
      displayPositionFor: () => ({
        status: "shifted" as const,
        range: { sl: 2, sc: 1, el: 2, ec: 1 },
      }),
    });
    expect(marks).toHaveLength(0);
  });

  test("restores the overlay when the latest event is 'unresolve'", () => {
    const ev = (id: number, event: "resolve" | "unresolve"): ExistingComment => ({
      id,
      source: "review",
      author: "x",
      body: event === "resolve" ? "Resolved." : "Reopened.",
      meta: {
        cid: `e${id}`,
        path: "a.md",
        range: { sl: 2, sc: 1, el: 2, ec: 1 },
        quote: "line two",
        sha: "HEAD",
        thread: "t1",
        kind: "comment",
        event,
      },
    });
    // Latest event (highest id) wins: resolve(id=2) then unresolve(id=3) → reopened
    const comments = [suggestionComment(), ev(2, "resolve"), ev(3, "unresolve")];
    const marks = buildSuggestionMarks({
      comments,
      source,
      lineStarts,
      currentPath: "a.md",
      dismissed: {},
      displayPositionFor: dpFromAnchor(comments),
    });
    expect(marks).toHaveLength(1);
  });
});

describe("canReplyToThread", () => {
  test("true for a Bark-authored thread (root carries metadata to anchor the reply)", () => {
    const threads = buildThreads([comment({ id: 1, meta: meta(5) })], [], "a.md");
    expect(canReplyToThread(threads[0]!)).toBe(true);
  });

  test("true for a draft-only thread (root draft anchors the reply)", () => {
    const threads = buildThreads([], [draft({ cid: "d1" })], "a.md");
    expect(canReplyToThread(threads[0]!)).toBe(true);
  });

  test("true for a foreign review thread with a line (anchors to GitHub's native line)", () => {
    const foreign = comment({
      id: 9,
      meta: null,
      threadKey: "foreign-thread-PRT_a",
      path: "a.md",
      line: 3,
    });
    const threads = buildThreads([foreign], [], "a.md");
    expect(canReplyToThread(threads[0]!)).toBe(true);
  });

  test("false for a foreign review thread without a line (nothing to anchor to)", () => {
    const foreign = comment({ id: 9, meta: null, threadKey: "k", path: "a.md" });
    const threads = buildThreads([foreign], [], "a.md");
    expect(canReplyToThread(threads[0]!)).toBe(false);
  });

  test("false for a foreign issue thread (GitHub issue comments are flat; issue #183)", () => {
    const foreign = comment({ id: 9, source: "issue", meta: null, threadKey: "k" });
    const threads = buildThreads([foreign], [], "a.md");
    expect(canReplyToThread(threads[0]!)).toBe(false);
  });
});

describe("buildThreads — foreign grouping by threadKey", () => {
  test("foreign comments sharing a threadKey group into one thread", () => {
    const root = comment({ id: 10, meta: null, threadKey: "foreign-thread-PRT_a", line: 3 });
    const reply = comment({ id: 11, meta: null, threadKey: "foreign-thread-PRT_a", line: 3 });
    const threads = buildThreads([root, reply], [], "a.md");
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe("foreign-thread-PRT_a");
    expect(threads[0]!.messages).toHaveLength(2);
  });

  test("a reply draft keyed to the foreign thread id nests under it (issue #183)", () => {
    const root = comment({ id: 10, meta: null, threadKey: "foreign-thread-PRT_a", line: 3 });
    const reply = draft({ cid: "d1", thread: "foreign-thread-PRT_a" });
    const threads = buildThreads([root], [reply], "a.md");
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messages.map((m) => m.kind)).toEqual(["submitted", "pending"]);
  });

  test("a comment without meta or threadKey still falls back to a solo thread", () => {
    const threads = buildThreads([comment({ id: 12, meta: null, line: 3 })], [], "a.md");
    expect(threads[0]!.id).toBe("solo:review:12");
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

describe("filterReviewEntries — pending reply on a resolved thread (#193)", () => {
  // A resolved thread that carries an unsubmitted reply draft. Its pending
  // content is part of the Submit count, so the sidebar must surface it too —
  // otherwise Pending says (0) while Submit says (1) and the draft is invisible.
  const comments = [
    comment({ id: 1, meta: meta(5, "a.md", "t1") }),
    comment({ id: 2, meta: { ...meta(5, "a.md", "t1"), cid: "e2", event: "resolve" } }),
  ];
  const drafts = [draft({ cid: "d1", thread: "t1", range: { sl: 5, sc: 1, el: 5, ec: 5 } })];
  const threads = buildThreads(comments, drafts, "a.md");
  const entries = buildReviewEntries({ threads, pendingSuggestions: [], currentPath: "a.md" });

  test("the resolved thread's pending reply shows under the pending facet", () => {
    const pending = filterReviewEntries(entries, new Set(["pending"] as const));
    expect(pending).toHaveLength(1);
    expect(pending[0].kind === "thread" && pending[0].thread.id).toBe("t1");
  });

  test("pending count agrees with the submit count (both include the reply)", () => {
    const counts = reviewEntryCounts(entries);
    expect(counts.pending).toBe(1);
    // Submit consumes buildPendingItems, which counts every draft with no
    // resolved check — so 1 pending item must match the 1 pending sidebar entry.
    expect(buildPendingItems(drafts, [])).toHaveLength(1);
  });

  test("it still counts under resolved (a resolved thread is resolved)", () => {
    const counts = reviewEntryCounts(entries);
    expect(counts.resolved).toBe(1);
  });
});

describe("revealSubmittedFacets", () => {
  test("adds 'submitted' so just-submitted items stay visible", () => {
    expect(revealSubmittedFacets(new Set(["pending"]))).toEqual(new Set(["pending", "submitted"]));
  });

  test("preserves the user's 'resolved' preference when it was off", () => {
    const next = revealSubmittedFacets(new Set(["pending", "submitted"]));
    expect(next.has("resolved")).toBe(false);
  });

  test("keeps 'resolved' on when the user already had it on", () => {
    const next = revealSubmittedFacets(new Set(["pending", "submitted", "resolved"]));
    expect(next.has("resolved")).toBe(true);
  });

  test("returns a new set without mutating the input", () => {
    const prev = new Set(["pending"] as const);
    const next = revealSubmittedFacets(prev);
    expect(next).not.toBe(prev);
    expect(prev).toEqual(new Set(["pending"]));
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

describe("sortPos", () => {
  test("line dominates, column breaks ties", () => {
    expect(sortPos(2, 1)).toBeGreaterThan(sortPos(1, 9999));
    expect(sortPos(5, 3)).toBeGreaterThan(sortPos(5, 1));
    expect(sortPos(5, 1)).toBe(500001);
  });
});

describe("buildAuthorPendingItems", () => {
  const accepted: AcceptedSuggestionInfo[] = [
    { commentId: 42, path: "docs/a.md", quote: "old", replacement: "new", line: 3 },
  ];

  test("emits an 'edit' item for each file whose source differs from base", () => {
    const edits: Record<string, SuggestionEdit> = {
      "docs/a.md": { source: "x", base: "y", comments: {} },
      "docs/b.md": { source: "z", base: "z", comments: {} }, // no diff
    };
    const items = buildAuthorPendingItems([], edits, []);
    const edit = items.filter((i) => i.kind === "edit");
    expect(edit.map((i) => (i.kind === "edit" ? i.path : ""))).toEqual(["docs/a.md"]);
  });

  test("emits one 'acceptedSuggestion' item per accepted comment", () => {
    const items = buildAuthorPendingItems([], {}, accepted);
    const acc = items.filter((i) => i.kind === "acceptedSuggestion");
    expect(acc).toHaveLength(1);
    expect(acc[0].kind === "acceptedSuggestion" && acc[0].commentId).toBe(42);
    expect(acc[0].kind === "acceptedSuggestion" && acc[0].path).toBe("docs/a.md");
    expect(acc[0].kind === "acceptedSuggestion" && acc[0].replacement).toBe("new");
  });

  test("includes comment/reply drafts unchanged", () => {
    const drafts = [draft({ cid: "d1", body: "hi" })];
    const items = buildAuthorPendingItems(drafts, {}, []);
    expect(items.filter((i) => i.kind === "comment")).toHaveLength(1);
  });

  test("combines drafts, edits, and accepted suggestions on disjoint files", () => {
    const drafts = [draft({ cid: "d1" })];
    const edits: Record<string, SuggestionEdit> = {
      "docs/c.md": { source: "x", base: "y", comments: {} }, // manual edit, no accept
    };
    const items = buildAuthorPendingItems(drafts, edits, accepted);
    expect(items).toHaveLength(3);
    const kinds = new Set(items.map((i) => i.kind));
    expect(kinds).toEqual(new Set(["comment", "edit", "acceptedSuggestion"]));
  });

  test("regression: one accept yields one item (was double-counted as 2)", () => {
    // Accepting a suggestion in author mode applies the replacement to the
    // source AND records the dismissed entry. Before the fix, that produced
    // both an `acceptedSuggestion` item AND a separate `edit` item for the
    // same file, so the topbar Submit (n) counter showed 2 for a single
    // logical action. The accept already implies the file is in the commit,
    // so the `edit` item is redundant.
    const items = buildAuthorPendingItems(
      [],
      { "docs/a.md": { source: "new line", base: "old line", comments: {} } },
      [{ commentId: 42, path: "docs/a.md", quote: "old line", replacement: "new line", line: 3 }],
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("acceptedSuggestion");
  });

  test("keeps the 'edit' item when the file has manual edits and no accepts", () => {
    const items = buildAuthorPendingItems(
      [],
      { "docs/c.md": { source: "edited", base: "orig", comments: {} } },
      [],
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("edit");
  });

  test("multiple accepts on the same file emit one item per accept (no edit)", () => {
    const items = buildAuthorPendingItems(
      [],
      { "docs/a.md": { source: "post-accepts", base: "before", comments: {} } },
      [
        { commentId: 1, path: "docs/a.md", quote: "a", replacement: "A", line: 1 },
        { commentId: 2, path: "docs/a.md", quote: "b", replacement: "B", line: 3 },
      ],
    );
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "acceptedSuggestion")).toBe(true);
  });
});

describe("summarizePending — author variants", () => {
  test("counts editedFiles by union of accepted-suggestion + edit paths", () => {
    const items = buildAuthorPendingItems(
      [],
      {
        "docs/a.md": { source: "x", base: "y", comments: {} },
        "docs/b.md": { source: "z", base: "w", comments: {} },
      },
      [
        { commentId: 1, path: "docs/a.md", quote: "old", replacement: "new", line: 1 },
        { commentId: 2, path: "docs/b.md", quote: "p", replacement: "q", line: 2 },
        { commentId: 3, path: "docs/a.md", quote: "r", replacement: "s", line: 3 },
      ],
    );
    // Both files have accepts → no `edit` items emitted; commit covers both.
    const s = summarizePending(items);
    expect(s.commit).toEqual({ editedFiles: 2, acceptances: 3 });
    expect(s.total).toBe(3);
  });

  test("counts edit-only files too (no accept on that file)", () => {
    const items = buildAuthorPendingItems(
      [],
      {
        "docs/a.md": { source: "x", base: "y", comments: {} }, // accept
        "docs/c.md": { source: "z", base: "w", comments: {} }, // manual only
      },
      [{ commentId: 1, path: "docs/a.md", quote: "old", replacement: "new", line: 1 }],
    );
    const s = summarizePending(items);
    expect(s.commit).toEqual({ editedFiles: 2, acceptances: 1 });
    expect(s.total).toBe(2);
  });

  test("commit group is zero when there are no author items", () => {
    const items = buildPendingItems([draft({ cid: "d1" })], []);
    const s = summarizePending(items);
    expect(s.commit).toEqual({ editedFiles: 0, acceptances: 0 });
  });
});

describe("groupPendingByFile — author variants", () => {
  test("groups acceptedSuggestion + comment by path (edit suppressed by accept)", () => {
    const items = buildAuthorPendingItems(
      [draft({ cid: "d1", path: "docs/a.md", range: { sl: 5, sc: 1, el: 5, ec: 5 } })],
      { "docs/a.md": { source: "x", base: "y", comments: {} } },
      [{ commentId: 1, path: "docs/a.md", quote: "old", replacement: "new", line: 2 }],
    );
    const groups = groupPendingByFile(items);
    expect(groups.map((g) => g.path)).toEqual(["docs/a.md"]);
    expect(groups[0].items).toHaveLength(2);
    // Sort puts accepted suggestion (line 2) before comment (line 5).
    const order = groups[0].items.map((i) => i.kind);
    expect(order).toEqual(["acceptedSuggestion", "comment"]);
  });

  test("'edit' items show up for files that have manual edits and no accept", () => {
    const items = buildAuthorPendingItems(
      [],
      { "docs/c.md": { source: "z", base: "w", comments: {} } },
      [],
    );
    const groups = groupPendingByFile(items);
    expect(groups.map((g) => g.path)).toEqual(["docs/c.md"]);
    expect(groups[0].items[0].kind).toBe("edit");
  });
});

describe("composerInsertIndex", () => {
  const entries = (...positions: number[]) => positions.map((sortPos) => ({ sortPos }));

  test("returns 0 for an empty list", () => {
    expect(composerInsertIndex([], 12345)).toBe(0);
  });

  test("inserts before the first entry positioned after it", () => {
    // entries at lines 1, 5, 9 → a selection on line 5 sorts before the line-9 entry.
    const list = entries(sortPos(1, 1), sortPos(9, 1));
    expect(composerInsertIndex(list, sortPos(5, 1))).toBe(1);
  });

  test("inserts at the front when it precedes every entry", () => {
    const list = entries(sortPos(4, 1), sortPos(8, 1));
    expect(composerInsertIndex(list, sortPos(2, 1))).toBe(0);
  });

  test("appends when it follows every entry", () => {
    const list = entries(sortPos(1, 1), sortPos(3, 1));
    expect(composerInsertIndex(list, sortPos(9, 1))).toBe(2);
  });

  test("an equal-position entry sorts before the composer (stable tie-break)", () => {
    const list = entries(sortPos(5, 1), sortPos(7, 1));
    expect(composerInsertIndex(list, sortPos(5, 1))).toBe(1);
  });
});

describe("deriveRole", () => {
  test("author when the viewer login equals the PR author", () => {
    expect(deriveRole("nownabe", "nownabe")).toBe("author");
  });
  test("case-insensitive match still yields author", () => {
    expect(deriveRole("NowNabe", "nownabe")).toBe("author");
  });
  test("reviewer when logins differ", () => {
    expect(deriveRole("octocat", "nownabe")).toBe("reviewer");
  });
  test("reviewer when either side is null/empty/undefined", () => {
    expect(deriveRole(null, "nownabe")).toBe("reviewer");
    expect(deriveRole("nownabe", null)).toBe("reviewer");
    expect(deriveRole("", "")).toBe("reviewer");
    expect(deriveRole(undefined, undefined)).toBe("reviewer");
  });
});
