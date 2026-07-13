import { describe, expect, test } from "bun:test";
import {
  applyAcceptedSuggestion,
  charDiffs,
  diffToSuggestions,
  extractSuggestionBlock,
  isMeaningfulEdit,
  rebaseEdit,
  rebaseLoadedEdit,
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

  // Regression: when the suggestion content contained a ``` code fence the
  // lazy regex stopped at the inner fence, so extractSuggestionBlock truncated
  // the suggestion and stripSuggestionBlock left orphaned fence text behind.
  // The helpers must recognize longer outer fences (≥3 backticks) so a 4- or
  // 5-tick wrapper round-trips with content that contains 3- or 4-tick fences.
  test("extractSuggestionBlock preserves inner ``` when the outer fence is longer", () => {
    const inner = "before\n```js\nconst x = 1;\n```\nafter";
    expect(extractSuggestionBlock("hi\n\n````suggestion\n" + inner + "\n````")).toBe(inner);
  });

  test("stripSuggestionBlock removes a longer outer fence cleanly", () => {
    const inner = "before\n```js\nconst x = 1;\n```\nafter";
    expect(stripSuggestionBlock("hi\n\n````suggestion\n" + inner + "\n````")).toBe("hi");
  });

  // GitHub's API returns comment bodies with CRLF endings; the helpers must
  // trim the outer \r so the extracted replacement matches \n-normalised source.
  test("extractSuggestionBlock tolerates CRLF fence lines", () => {
    expect(extractSuggestionBlock("hi\r\n\r\n```suggestion\r\nnew code\r\n```")).toBe("new code");
  });

  test("stripSuggestionBlock removes a CRLF fence", () => {
    expect(stripSuggestionBlock("hi\r\n\r\n```suggestion\r\nnew\r\n```")).toBe("hi");
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

describe("rebaseEdit / rebaseLoadedEdit (issue #187 recovery)", () => {
  test("re-applies the author's edit cleanly onto a new base with unrelated upstream changes", () => {
    const base = "alpha\nbravo\ncharlie\ndelta\n";
    const edited = "alpha\nBRAVO!\ncharlie\ndelta\n"; // author edits line 2
    const newBase = "alpha\nbravo\ncharlie\nDELTA (upstream)\n"; // upstream edits line 4
    const out = rebaseEdit(base, edited, newBase);
    expect(out.clean).toBe(true);
    expect(out.source).toBe("alpha\nBRAVO!\ncharlie\nDELTA (upstream)\n");
  });

  test("reports clean: false when upstream rewrote the same region", () => {
    const base = "one two three";
    const edited = "one TWO three"; // author edits the middle word
    const newBase = "completely different text"; // upstream rewrote everything
    const out = rebaseEdit(base, edited, newBase);
    expect(out.clean).toBe(false);
  });

  test("rebaseLoadedEdit stamps baseSha and keeps the edit when the base is unchanged", () => {
    const edit = { source: "edited", base: "base", comments: {} };
    const out = rebaseLoadedEdit(edit, "base", "h1");
    expect(out.status).toBe("unchanged");
    expect(out.edit).toEqual({ source: "edited", base: "base", baseSha: "h1", comments: {} });
  });

  test("rebaseLoadedEdit rebuilds a clean merge on the new base", () => {
    const edit = {
      source: "alpha\nBRAVO!\ncharlie\ndelta\n",
      base: "alpha\nbravo\ncharlie\ndelta\n",
      baseSha: "h0",
      comments: { c: "note" },
    };
    const out = rebaseLoadedEdit(edit, "alpha\nbravo\ncharlie\nDELTA (upstream)\n", "h1");
    expect(out.status).toBe("rebased");
    expect(out.edit).toEqual({
      source: "alpha\nBRAVO!\ncharlie\nDELTA (upstream)\n",
      base: "alpha\nbravo\ncharlie\nDELTA (upstream)\n",
      baseSha: "h1",
      comments: { c: "note" },
    });
  });

  test("rebaseLoadedEdit returns the edit UNCHANGED on a dirty merge (old base/baseSha kept)", () => {
    const edit = {
      source: "one TWO three",
      base: "one two three",
      baseSha: "h0",
      comments: {},
    };
    const out = rebaseLoadedEdit(edit, "completely different text", "h1");
    expect(out.status).toBe("conflict");
    // Anchored to the old base so the commit pipeline keeps refusing it
    // instead of silently dropping the author's hunks.
    expect(out.edit).toEqual(edit);
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

  // The new layer's CommentView.displayPosition is what the caller supplies.
  // For anchors at the current head, that mirrors the meta's own range.
  const dpCurrent = (range: { sl: number; sc: number; el: number; ec: number }) => ({
    status: "current" as const,
    range,
  });

  test("single-line accept REPLACES the quoted text (regression: was concatenating)", () => {
    // Bug repro: source has "line two" on its own line. The stored anchor is
    // line-based (sc=1, ec=1) and the displayPosition collapses to zero
    // width for a single-line replacement. Before the fix, slice(0,from) +
    // repl + slice(end) inserted the replacement next to the original
    // instead of overwriting it.
    const source = "line one\nline two\nline three\n";
    const lineStarts = buildLineIndex(source);
    const meta = suggestionMeta();
    const out = applyAcceptedSuggestion({
      source,
      baseSource: source,
      lineStarts,
      meta,
      replacement: "LINE TWO",
      displayPosition: dpCurrent(meta.range),
    });
    expect(out).toBe("line one\nLINE TWO\nline three\n");
    // The pre-fix output would have been: "line one\nLINE TWOline two\nline three\n"
    expect(out).not.toContain("line two"); // original gone
  });

  test("multi-line accept replaces every quoted line", () => {
    const source = "h1\nx\ny\nz\nh2\n";
    const lineStarts = buildLineIndex(source);
    const meta = suggestionMeta({
      range: { sl: 2, sc: 1, el: 4, ec: 1 },
      quote: "x\ny\nz",
    });
    const out = applyAcceptedSuggestion({
      source,
      baseSource: source,
      lineStarts,
      meta,
      replacement: "X\nY",
      displayPosition: dpCurrent(meta.range),
    });
    expect(out).toBe("h1\nX\nY\nh2\n");
  });

  test("uses the displayPosition range (re-anchored to a shifted line)", () => {
    // The new layer already reanchored the comment to a shifted line; the
    // caller passes that displayPosition through.
    const source = "INSERTED\nline one\nline two\nline three\n";
    const lineStarts = buildLineIndex(source);
    const out = applyAcceptedSuggestion({
      source,
      baseSource: source,
      lineStarts,
      meta: suggestionMeta({ sha: "OLD" }),
      replacement: "LINE TWO",
      displayPosition: { status: "mapped", range: { sl: 3, sc: 1, el: 3, ec: 1 } },
    });
    expect(out).toBe("INSERTED\nline one\nLINE TWO\nline three\n");
  });

  test("outdated displayPosition returns null and leaves the source untouched", () => {
    const source = "totally different content\n";
    const lineStarts = buildLineIndex(source);
    const out = applyAcceptedSuggestion({
      source,
      baseSource: source,
      lineStarts,
      meta: suggestionMeta({ sha: "OLD", quote: "not present" }),
      replacement: "anything",
      displayPosition: { status: "outdated" },
    });
    expect(out).toBeNull();
  });

  // Issue #176: applyAcceptedSuggestion replaced quote.length chars at the
  // mapped position without checking the text there still matches the quote,
  // so a suggestion whose target changed since it was written cut mid-line
  // and staged corrupted content into the commit.
  describe("quote verification (issue #176)", () => {
    test("refuses when the target's interior changed (shifted position)", () => {
      // The suggestion targets "x\ny\nz" but "y" changed since. The mapped
      // endpoints still exist so reanchor reports "shifted"; slicing
      // quote.length chars there would cut mid-line.
      const source = "h1\nx\nY-CHANGED\nz\nh2\n";
      const lineStarts = buildLineIndex(source);
      const meta = suggestionMeta({
        sha: "OLD",
        range: { sl: 2, sc: 1, el: 4, ec: 1 },
        quote: "x\ny\nz",
      });
      const out = applyAcceptedSuggestion({
        source,
        baseSource: source,
        lineStarts,
        meta,
        replacement: "X\nY",
        displayPosition: { status: "shifted", range: { sl: 2, sc: 1, el: 4, ec: 1 } },
      });
      expect(out).toBeNull();
    });

    test("refuses a mapped position whose text was altered (defense in depth)", () => {
      const source = "line one\nline 2!!\nline three\n";
      const lineStarts = buildLineIndex(source);
      const out = applyAcceptedSuggestion({
        source,
        baseSource: source,
        lineStarts,
        meta: suggestionMeta({ sha: "OLD" }), // quote: "line two"
        replacement: "LINE TWO",
        displayPosition: { status: "mapped", range: { sl: 2, sc: 1, el: 2, ec: 1 } },
      });
      expect(out).toBeNull();
    });

    test("applies a shifted position when the target text is byte-identical", () => {
      // States persisted before the reanchor fix may still carry "shifted"
      // for intact targets (line-based anchors were misclassified). The
      // quote check is the gate, not the status label.
      const source = "line one\nline two\nline three\n";
      const lineStarts = buildLineIndex(source);
      const meta = suggestionMeta({ sha: "OLD" });
      const out = applyAcceptedSuggestion({
        source,
        baseSource: source,
        lineStarts,
        meta,
        replacement: "LINE TWO",
        displayPosition: { status: "shifted", range: meta.range },
      });
      expect(out).toBe("line one\nLINE TWO\nline three\n");
    });
  });

  test("empty replacement = line deletion", () => {
    const source = "a\nb\nc\n";
    const lineStarts = buildLineIndex(source);
    const meta = suggestionMeta({ range: { sl: 2, sc: 1, el: 2, ec: 1 }, quote: "b" });
    const out = applyAcceptedSuggestion({
      source,
      baseSource: source,
      lineStarts,
      meta,
      replacement: "",
      displayPosition: dpCurrent(meta.range),
    });
    // Deleting "b" removes its trailing newline too (matching GitHub's Apply),
    // so no stray blank line remains.
    expect(out).toBe("a\nc\n");
  });

  // Issue #191: accepting a line-deletion suggestion (empty replacement) left a
  // stray blank line because the replaced span excluded the deleted line's
  // trailing newline. When the replacement is empty and the span covers whole
  // line(s), the newline must be absorbed too so the result matches GitHub's
  // own Apply button.
  describe("line-deletion trailing newline (issue #191)", () => {
    test("deleting a middle line removes its trailing newline", () => {
      const source = "a\nb\nc\n";
      const lineStarts = buildLineIndex(source);
      const meta = suggestionMeta({ range: { sl: 2, sc: 1, el: 2, ec: 1 }, quote: "b" });
      const out = applyAcceptedSuggestion({
        source,
        baseSource: source,
        lineStarts,
        meta,
        replacement: "",
        displayPosition: dpCurrent(meta.range),
      });
      expect(out).toBe("a\nc\n");
    });

    test("deleting the last line (file has a trailing newline) leaves no blank line", () => {
      const source = "a\nb\nc\n";
      const lineStarts = buildLineIndex(source);
      const meta = suggestionMeta({ range: { sl: 3, sc: 1, el: 3, ec: 1 }, quote: "c" });
      const out = applyAcceptedSuggestion({
        source,
        baseSource: source,
        lineStarts,
        meta,
        replacement: "",
        displayPosition: dpCurrent(meta.range),
      });
      expect(out).toBe("a\nb\n");
    });

    test("deleting the last line (no trailing newline) absorbs the preceding newline", () => {
      const source = "a\nb\nc";
      const lineStarts = buildLineIndex(source);
      const meta = suggestionMeta({ range: { sl: 3, sc: 1, el: 3, ec: 1 }, quote: "c" });
      const out = applyAcceptedSuggestion({
        source,
        baseSource: source,
        lineStarts,
        meta,
        replacement: "",
        displayPosition: dpCurrent(meta.range),
      });
      expect(out).toBe("a\nb");
    });

    test("multi-line deletion removes the whole block plus its trailing newline", () => {
      const source = "a\nb\nc\nd\n";
      const lineStarts = buildLineIndex(source);
      const meta = suggestionMeta({ range: { sl: 2, sc: 1, el: 3, ec: 1 }, quote: "b\nc" });
      const out = applyAcceptedSuggestion({
        source,
        baseSource: source,
        lineStarts,
        meta,
        replacement: "",
        displayPosition: dpCurrent(meta.range),
      });
      expect(out).toBe("a\nd\n");
    });

    test("non-empty replacement is unaffected (no newline absorbed)", () => {
      const source = "a\nb\nc\n";
      const lineStarts = buildLineIndex(source);
      const meta = suggestionMeta({ range: { sl: 2, sc: 1, el: 2, ec: 1 }, quote: "b" });
      const out = applyAcceptedSuggestion({
        source,
        baseSource: source,
        lineStarts,
        meta,
        replacement: "B",
        displayPosition: dpCurrent(meta.range),
      });
      expect(out).toBe("a\nB\nc\n");
    });
  });

  // Issue #177: displayPosition is computed against the head-SHA file
  // (baseSource), but the accept applies it to the author's locally edited
  // source. After an earlier accept or manual edit changed the line count,
  // the head-space line number pointed at the wrong local line — replacing
  // the wrong text when the quote happened to match there, or refusing a
  // perfectly valid accept when it didn't. The target line must be re-mapped
  // from head coordinates to edited coordinates before applying.
  describe("composing accepts / local edits (issue #177)", () => {
    // Head file: suggestion B targets line 5 ("old2"). An earlier accept
    // grew line 2 into two lines, shifting everything below down by one.
    const baseSource = "intro\nold1\nsame\nsame\nold2\nsame\n";

    test("applies at the re-mapped line after an earlier accept shifted lines down", () => {
      const source = "intro\nAAA\nBBB\nsame\nsame\nold2\nsame\n";
      const lineStarts = buildLineIndex(source);
      const meta = suggestionMeta({ range: { sl: 5, sc: 1, el: 5, ec: 1 }, quote: "old2" });
      const out = applyAcceptedSuggestion({
        source,
        baseSource,
        lineStarts,
        meta,
        replacement: "NEW2",
        displayPosition: dpCurrent(meta.range),
      });
      expect(out).toBe("intro\nAAA\nBBB\nsame\nsame\nNEW2\nsame\n");
    });

    test("does NOT replace a coincidentally matching wrong line after lines shifted up", () => {
      // Head file: an earlier accept collapsed lines 2-4 into one line,
      // shifting everything below up by two. Suggestion B targets head
      // line 5 (the first "dup"); the unmapped head line number now lands
      // on the LAST "dup" — the quote matches there, so before the fix the
      // wrong occurrence was silently replaced.
      const base = "h\nx\ny\nz\ndup\ndup\ndup\nend\n";
      const source = "h\nX\ndup\ndup\ndup\nend\n";
      const lineStarts = buildLineIndex(source);
      const meta = suggestionMeta({ range: { sl: 5, sc: 1, el: 5, ec: 1 }, quote: "dup" });
      const out = applyAcceptedSuggestion({
        source,
        baseSource: base,
        lineStarts,
        meta,
        replacement: "DUP!",
        displayPosition: dpCurrent(meta.range),
      });
      // The first dup (head line 5 → edited line 3) is replaced, not the last.
      expect(out).toBe("h\nX\nDUP!\ndup\ndup\nend\n");
    });

    test("refuses when a local edit changed the target line itself", () => {
      const source = "intro\nold1\nsame\nsame\nold2-EDITED\nsame\n";
      const lineStarts = buildLineIndex(source);
      const meta = suggestionMeta({ range: { sl: 5, sc: 1, el: 5, ec: 1 }, quote: "old2" });
      const out = applyAcceptedSuggestion({
        source,
        baseSource,
        lineStarts,
        meta,
        replacement: "NEW2",
        displayPosition: dpCurrent(meta.range),
      });
      expect(out).toBeNull();
    });

    test("refuses when an earlier accept deleted the target line", () => {
      // Head lines 4-6 were collapsed to one line by an earlier multi-line
      // accept; suggestion B's target (head line 5) no longer exists.
      const base = "a\nb\nc\nx\ny\nz\nd\n";
      const source = "a\nb\nc\nX\nd\n";
      const lineStarts = buildLineIndex(source);
      const meta = suggestionMeta({ range: { sl: 5, sc: 1, el: 5, ec: 1 }, quote: "y" });
      const out = applyAcceptedSuggestion({
        source,
        baseSource: base,
        lineStarts,
        meta,
        replacement: "Y",
        displayPosition: dpCurrent(meta.range),
      });
      expect(out).toBeNull();
    });

    test("multi-line accept re-maps and applies after an upstream line-count change", () => {
      const base = "top\nold\nx\ny\nz\nbottom\n";
      // Earlier accept turned "old" into three lines (+2).
      const source = "top\nn1\nn2\nn3\nx\ny\nz\nbottom\n";
      const lineStarts = buildLineIndex(source);
      const meta = suggestionMeta({ range: { sl: 3, sc: 1, el: 5, ec: 1 }, quote: "x\ny\nz" });
      const out = applyAcceptedSuggestion({
        source,
        baseSource: base,
        lineStarts,
        meta,
        replacement: "X\nY",
        displayPosition: dpCurrent(meta.range),
      });
      expect(out).toBe("top\nn1\nn2\nn3\nX\nY\nbottom\n");
    });
  });
});

// Issue #194: adding or removing only the file's final newline used to count as
// a pending edit (persisted, decorated as tracked changes) that could never be
// submitted or discarded — diffToSuggestions returns zero hunks for it, so no
// review-list item exists and Submit early-returns. isMeaningfulEdit is the
// single dirty-check both the persistence gate and the load path share, so a
// trailing-newline-only difference no longer registers as a pending change.
describe("isMeaningfulEdit (issue #194)", () => {
  test("identical text is not a pending edit", () => {
    expect(isMeaningfulEdit("a\nb\n", "a\nb\n")).toBe(false);
  });

  test("adding only the final newline is not a pending edit", () => {
    expect(isMeaningfulEdit("a\nb", "a\nb\n")).toBe(false);
  });

  test("removing only the final newline is not a pending edit", () => {
    expect(isMeaningfulEdit("a\nb\n", "a\nb")).toBe(false);
  });

  test("a real content change is a pending edit", () => {
    expect(isMeaningfulEdit("a\nb\n", "a\nB\n")).toBe(true);
  });

  test("a real change plus a newline toggle is still a pending edit", () => {
    expect(isMeaningfulEdit("a\nb\n", "a\nB")).toBe(true);
  });

  test("adding a whole blank line (not just the final newline) is a pending edit", () => {
    expect(isMeaningfulEdit("a\nb\n", "a\nb\n\n")).toBe(true);
  });

  test("agrees with diffToSuggestions: newline-only edits produce no hunks", () => {
    // The bug's core invariant: whenever there are no hunks to submit, the edit
    // must not register as pending. A newline-only edit has zero hunks.
    expect(diffToSuggestions("a\nb", "a\nb\n")).toEqual([]);
    expect(isMeaningfulEdit("a\nb", "a\nb\n")).toBe(false);
  });
});
