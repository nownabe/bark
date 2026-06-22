import { describe, expect, test } from "bun:test";
import {
  applyAcceptedSuggestion,
  charDiffs,
  diffToSuggestions,
  extractSuggestionBlock,
  stripSuggestionBlock,
  suggestionEditRanges,
} from "../lib/suggest";
import { buildLineIndex } from "../lib/anchor";
import type { CommentMetadata } from "../lib/metadata";

describe("diffToSuggestions", () => {
  test("single-line replacement", () => {
    const h = diffToSuggestions("line1\nline2\nline3\n", "line1\nLINE2 changed\nline3\n");
    expect(h).toEqual([{ sl: 2, el: 2, replacement: "LINE2 changed", quote: "line2" }]);
  });

  test("line deletion has empty replacement", () => {
    const h = diffToSuggestions("a\nb\nc\n", "a\nc\n");
    expect(h).toEqual([{ sl: 2, el: 2, replacement: "", quote: "b" }]);
  });

  test("multi-line replacement", () => {
    const h = diffToSuggestions("h1\nx\ny\nz\nh2\n", "h1\nX\nY\nh2\n");
    expect(h).toEqual([{ sl: 2, el: 4, replacement: "X\nY", quote: "x\ny\nz" }]);
  });

  test("no change yields no hunks", () => {
    expect(diffToSuggestions("a\nb\n", "a\nb\n")).toEqual([]);
  });

  // Pure insertions (no surrounding line was modified) used to be silently
  // dropped because GitHub suggestions need a target line. We now absorb the
  // adjacent base line into the hunk so the insertion still surfaces as a
  // pending suggestion in the sidebar.
  describe("pure insertion (no deleted line)", () => {
    test("inserting between two unchanged lines anchors to the next line", () => {
      const h = diffToSuggestions("a\nb\n", "a\nX\nb\n");
      expect(h).toEqual([{ sl: 2, el: 2, replacement: "X\nb", quote: "b" }]);
    });

    test("inserting at the beginning anchors to the first base line", () => {
      const h = diffToSuggestions("a\n", "X\na\n");
      expect(h).toEqual([{ sl: 1, el: 1, replacement: "X\na", quote: "a" }]);
    });

    test("inserting at EOF (no next line) anchors to the previous base line", () => {
      const h = diffToSuggestions("a\n", "a\nX\n");
      expect(h).toEqual([{ sl: 1, el: 1, replacement: "a\nX", quote: "a" }]);
    });

    test("multi-line insertion picks up the next line once", () => {
      const h = diffToSuggestions("a\nb\n", "a\nX\nY\nb\n");
      expect(h).toEqual([{ sl: 2, el: 2, replacement: "X\nY\nb", quote: "b" }]);
    });

    test("inserting text between empty lines (the bug scenario)", () => {
      // base: 3 empty lines. user types "hello" on a new line between two of
      // them. Previously this produced 0 hunks (pure-insertion was skipped),
      // so the pending suggestion never appeared in the sidebar.
      const h = diffToSuggestions("\n\n\n", "\n\nhello\n\n");
      expect(h).toHaveLength(1);
      expect(h[0].replacement).toContain("hello");
    });
  });
});

describe("suggestionEditRanges", () => {
  test("single-line replacement: range covers the replacement text in the edited doc", () => {
    const edited = "line1\nLINE2 changed\nline3\n";
    const r = suggestionEditRanges("line1\nline2\nline3\n", edited);
    expect(r).toEqual([{ sl: 2, el: 2, from: 6, to: 19 }]);
    expect(edited.slice(r[0].from, r[0].to)).toBe("LINE2 changed");
  });

  test("multi-line replacement spans all replacement lines", () => {
    const edited = "h1\nX\nY\nh2\n";
    const r = suggestionEditRanges("h1\nx\ny\nz\nh2\n", edited);
    expect(r).toEqual([{ sl: 2, el: 4, from: 3, to: 6 }]);
    expect(edited.slice(r[0].from, r[0].to)).toBe("X\nY");
  });

  test("pure deletion collapses to the point where the text was", () => {
    const r = suggestionEditRanges("a\nb\nc\n", "a\nc\n");
    expect(r).toEqual([{ sl: 2, el: 2, from: 2, to: 2 }]);
  });

  test("ranges align by index with diffToSuggestions hunks", () => {
    const base = "a\nb\nc\nd\n";
    const edited = "a\nB\nc\nD\n";
    const hunks = diffToSuggestions(base, edited);
    const ranges = suggestionEditRanges(base, edited);
    expect(ranges).toHaveLength(hunks.length);
    expect(ranges.map((x) => [x.sl, x.el])).toEqual(hunks.map((h) => [h.sl, h.el]));
  });

  // suggestionEditRanges must stay aligned by index with diffToSuggestions; if
  // one emits a hunk for a pure insertion the other must too, otherwise the
  // App.tsx index mapping (`pendingSuggestions[k]?.cid`) breaks.
  describe("pure insertion ranges align with hunks", () => {
    test("middle insertion: range covers inserted block + anchor line", () => {
      const base = "a\nb\n";
      const edited = "a\nX\nb\n";
      const ranges = suggestionEditRanges(base, edited);
      const hunks = diffToSuggestions(base, edited);
      expect(ranges).toHaveLength(hunks.length);
      expect(ranges).toEqual([{ sl: 2, el: 2, from: 2, to: 5 }]);
      // Covers "X\nb" in the edited doc.
      expect(edited.slice(ranges[0].from, ranges[0].to)).toBe("X\nb");
    });

    test("beginning insertion: range starts at offset 0", () => {
      const base = "a\n";
      const edited = "X\na\n";
      const ranges = suggestionEditRanges(base, edited);
      expect(ranges).toEqual([{ sl: 1, el: 1, from: 0, to: 3 }]);
      expect(edited.slice(ranges[0].from, ranges[0].to)).toBe("X\na");
    });

    test("EOF insertion: range covers previous line + inserted block", () => {
      const base = "a\n";
      const edited = "a\nX\n";
      const ranges = suggestionEditRanges(base, edited);
      expect(ranges).toEqual([{ sl: 1, el: 1, from: 0, to: 3 }]);
      expect(edited.slice(ranges[0].from, ranges[0].to)).toBe("a\nX");
    });
  });
});

describe("suggestion block helpers", () => {
  test("extractSuggestionBlock returns the replacement", () => {
    expect(extractSuggestionBlock("hi\n\n```suggestion\nnew code\n```")).toBe("new code");
  });

  test("extractSuggestionBlock returns null when absent", () => {
    expect(extractSuggestionBlock("just a comment")).toBeNull();
  });

  test("stripSuggestionBlock removes the fence", () => {
    expect(stripSuggestionBlock("hi\n\n```suggestion\nnew\n```")).toBe("hi");
  });
});

describe("charDiffs", () => {
  test("reports insertions and deletions", () => {
    const diffs = charDiffs("hello world", "hello brave world");
    // Reconstruct the edited text from the diff ops (op 0 keep, 1 insert, -1 delete).
    const edited = diffs
      .filter(([op]) => op !== -1)
      .map(([, text]) => text)
      .join("");
    expect(edited).toBe("hello brave world");
    expect(diffs.some(([op]) => op === 1)).toBe(true);
  });
});

describe("applyAcceptedSuggestion", () => {
  function suggestionMeta(over: Partial<CommentMetadata> = {}): CommentMetadata {
    return {
      cid: "c1",
      path: "a.md",
      // Line-based anchor: this is how suggestions are stored — sc=1, ec=1.
      // The fact that this collapses to zero width when sha matches head was
      // the bug — applyAcceptedSuggestion must size the replaced span from
      // meta.quote, not from r.endOffset directly.
      range: { sl: 2, sc: 1, el: 2, ec: 1 },
      quote: "line two",
      sha: "HEAD",
      thread: "t1",
      kind: "suggestion",
      ...over,
    };
  }

  test("single-line accept REPLACES the quoted text (regression: was concatenating)", () => {
    // Bug repro: source has "line two" on its own line. The stored anchor is
    // line-based (sc=1, ec=1) and the meta's sha matches headSha, so
    // reanchorComment returns the stored range as-is → startOffset === endOffset.
    // Before the fix, slice(0,from) + repl + slice(end) inserted the
    // replacement next to the original instead of overwriting it.
    const source = "line one\nline two\nline three\n";
    const lineStarts = buildLineIndex(source);
    const out = applyAcceptedSuggestion({
      source,
      lineStarts,
      meta: suggestionMeta(),
      replacement: "LINE TWO",
      headSha: "HEAD",
    });
    expect(out).toBe("line one\nLINE TWO\nline three\n");
    // The pre-fix output would have been: "line one\nLINE TWOline two\nline three\n"
    expect(out).not.toContain("line two"); // original gone
  });

  test("multi-line accept replaces every quoted line", () => {
    const source = "h1\nx\ny\nz\nh2\n";
    const lineStarts = buildLineIndex(source);
    const out = applyAcceptedSuggestion({
      source,
      lineStarts,
      meta: suggestionMeta({
        range: { sl: 2, sc: 1, el: 4, ec: 1 },
        quote: "x\ny\nz",
      }),
      replacement: "X\nY",
      headSha: "HEAD",
    });
    expect(out).toBe("h1\nX\nY\nh2\n");
  });

  test("re-anchored: source shifted, locate via quote search", () => {
    // Source has a line inserted before the suggestion's target line; the
    // stored line numbers no longer match but the quote still matches.
    const source = "INSERTED\nline one\nline two\nline three\n";
    const lineStarts = buildLineIndex(source);
    const out = applyAcceptedSuggestion({
      source,
      lineStarts,
      meta: suggestionMeta({ sha: "OLD" }), // different from headSha → re-anchor
      replacement: "LINE TWO",
      headSha: "HEAD",
    });
    expect(out).toBe("INSERTED\nline one\nLINE TWO\nline three\n");
  });

  test("outdated (quote not found) returns null and leaves the source untouched", () => {
    const source = "totally different content\n";
    const lineStarts = buildLineIndex(source);
    const out = applyAcceptedSuggestion({
      source,
      lineStarts,
      meta: suggestionMeta({ sha: "OLD", quote: "not present" }),
      replacement: "anything",
      headSha: "HEAD",
    });
    expect(out).toBeNull();
  });

  test("empty replacement = line deletion", () => {
    const source = "a\nb\nc\n";
    const lineStarts = buildLineIndex(source);
    const out = applyAcceptedSuggestion({
      source,
      lineStarts,
      meta: suggestionMeta({ range: { sl: 2, sc: 1, el: 2, ec: 1 }, quote: "b" }),
      replacement: "",
      headSha: "HEAD",
    });
    // Replaces "b" with "" — the trailing newline before "c" remains.
    expect(out).toBe("a\n\nc\n");
  });
});
