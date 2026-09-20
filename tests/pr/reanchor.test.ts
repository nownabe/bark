import { describe, expect, test } from "bun:test";
import { buildLineMap } from "../../lib/pr/linemap";
import { locateLine, reanchor } from "../../lib/pr/reanchor";
import type { Anchor } from "../../lib/pr/types";

function anchor(overrides: Partial<Anchor> = {}): Anchor {
  return {
    sha: "old-sha",
    range: { sl: 1, sc: 1, el: 1, ec: 6 },
    quote: "hello",
    ...overrides,
  };
}

describe("reanchor", () => {
  test("when anchor.sha === currentHeadSha, returns current with the original range", () => {
    const result = reanchor(anchor({ sha: "head" }), "hello world", "head", null);
    expect(result).toEqual({ status: "current", range: { sl: 1, sc: 1, el: 1, ec: 6 } });
  });

  test("when oldSource is unavailable, returns outdated", () => {
    const result = reanchor(anchor(), "hello world", "head", null);
    expect(result).toEqual({ status: "outdated" });
  });

  test("unchanged content + identical quote → mapped at the same line", () => {
    const src = "line1\nhello\nline3";
    const result = reanchor(
      anchor({
        sha: "old",
        range: { sl: 2, sc: 1, el: 2, ec: 6 },
        quote: "hello",
      }),
      src,
      "head",
      src,
    );
    expect(result).toEqual({ status: "mapped", range: { sl: 2, sc: 1, el: 2, ec: 6 } });
  });

  test("the anchored line shifted down due to insertion → mapped at the new line", () => {
    const oldSrc = "line1\nhello\nline3";
    const newSrc = "line1\nINSERTED\nhello\nline3";
    const result = reanchor(
      anchor({
        sha: "old",
        range: { sl: 2, sc: 1, el: 2, ec: 6 },
        quote: "hello",
      }),
      newSrc,
      "head",
      oldSrc,
    );
    expect(result).toEqual({ status: "mapped", range: { sl: 3, sc: 1, el: 3, ec: 6 } });
  });

  test("the anchored line's content changed but the line was traced → shifted", () => {
    // Trick: anchor's line 2 was traced through (because surrounding lines unchanged),
    // but the line content itself changed. We map but quote-verify fails.
    // To force this, we'd need a scenario where LCS still pairs the line.
    // The straightforward case is when the anchor spans multiple lines and the inner
    // content changes; the endpoints map but the quote no longer matches.
    const oldSrc = "alpha\nbeta\ngamma\ndelta";
    const newSrc = "alpha\nbeta\nGAMMA-CHANGED\ndelta";
    const result = reanchor(
      anchor({
        sha: "old",
        range: { sl: 2, sc: 1, el: 4, ec: 6 },
        quote: "beta\ngamma\ndelta",
      }),
      newSrc,
      "head",
      oldSrc,
    );
    expect(result).toEqual({
      status: "shifted",
      range: { sl: 2, sc: 1, el: 4, ec: 6 },
    });
  });

  test("the anchored line was deleted → outdated", () => {
    const oldSrc = "line1\nhello\nline3";
    const newSrc = "line1\nline3";
    const result = reanchor(
      anchor({
        sha: "old",
        range: { sl: 2, sc: 1, el: 2, ec: 6 },
        quote: "hello",
      }),
      newSrc,
      "head",
      oldSrc,
    );
    expect(result).toEqual({ status: "outdated" });
  });

  test("partial deletion (one endpoint lost) → outdated, no half-truth clipping", () => {
    const oldSrc = "alpha\nbeta\ngamma\ndelta";
    const newSrc = "alpha\ngamma\ndelta"; // beta removed
    const result = reanchor(
      anchor({
        sha: "old",
        range: { sl: 2, sc: 1, el: 4, ec: 6 },
        quote: "beta\ngamma\ndelta",
      }),
      newSrc,
      "head",
      oldSrc,
    );
    expect(result).toEqual({ status: "outdated" });
  });

  test("empty quote is defensively outdated", () => {
    const src = "any source";
    const result = reanchor(anchor({ sha: "old", quote: "" }), src, "head", src);
    expect(result).toEqual({ status: "outdated" });
  });

  // Suggestion anchors are stored line-based (sc=1, ec=1) with quote = the
  // full lines sl..el joined by "\n" (issue #176). The char-based
  // extractTextAtRange can never reproduce that quote — it collapses to zero
  // width on a single line and drops the end line on multi-line ranges — so
  // byte-identical targets were misclassified "shifted" and the ADR-0004
  // quote-match safety check was inert for suggestions.
  describe("line-based (sc=1, ec=1) suggestion anchors", () => {
    test("single-line anchor over unchanged content → mapped, not shifted", () => {
      const src = "line1\nhello\nline3";
      const result = reanchor(
        anchor({ sha: "old", range: { sl: 2, sc: 1, el: 2, ec: 1 }, quote: "hello" }),
        src,
        "head",
        src,
      );
      expect(result).toEqual({ status: "mapped", range: { sl: 2, sc: 1, el: 2, ec: 1 } });
    });

    test("multi-line anchor over unchanged content → mapped", () => {
      const src = "a\nx\ny\nz\nb";
      const result = reanchor(
        anchor({ sha: "old", range: { sl: 2, sc: 1, el: 4, ec: 1 }, quote: "x\ny\nz" }),
        src,
        "head",
        src,
      );
      expect(result).toEqual({ status: "mapped", range: { sl: 2, sc: 1, el: 4, ec: 1 } });
    });

    test("anchor moved by an insertion but byte-identical → mapped at the new lines", () => {
      const oldSrc = "a\nx\ny\nb";
      const newSrc = "INSERTED\na\nx\ny\nb";
      const result = reanchor(
        anchor({ sha: "old", range: { sl: 2, sc: 1, el: 3, ec: 1 }, quote: "x\ny" }),
        newSrc,
        "head",
        oldSrc,
      );
      expect(result).toEqual({ status: "mapped", range: { sl: 3, sc: 1, el: 4, ec: 1 } });
    });

    test("interior line changed between mapped endpoints → shifted", () => {
      const oldSrc = "a\nx\ny\nz\nb";
      const newSrc = "a\nx\nY-CHANGED\nz\nb";
      const result = reanchor(
        anchor({ sha: "old", range: { sl: 2, sc: 1, el: 4, ec: 1 }, quote: "x\ny\nz" }),
        newSrc,
        "head",
        oldSrc,
      );
      expect(result).toEqual({ status: "shifted", range: { sl: 2, sc: 1, el: 4, ec: 1 } });
    });

    test("char-based anchor that happens to end at column 1 still verifies → mapped", () => {
      // A text selection from line 2 col 1 to line 3 col 1 quotes "x\n" —
      // the char-based interpretation must keep working alongside the
      // line-based one.
      const src = "a\nx\ny\nb";
      const result = reanchor(
        anchor({ sha: "old", range: { sl: 2, sc: 1, el: 3, ec: 1 }, quote: "x\n" }),
        src,
        "head",
        src,
      );
      expect(result).toEqual({ status: "mapped", range: { sl: 2, sc: 1, el: 3, ec: 1 } });
    });
  });

  test("never returns shifted when no LCS match found (no silent fuzzy fallback)", () => {
    // The anchored line and surrounding context all changed.
    const oldSrc = "a\nb\nc";
    const newSrc = "d\ne\nf";
    const result = reanchor(
      anchor({
        sha: "old",
        range: { sl: 2, sc: 1, el: 2, ec: 2 },
        quote: "b",
      }),
      newSrc,
      "head",
      oldSrc,
    );
    expect(result).toEqual({ status: "outdated" });
  });
});

// Issue #269: in prose Markdown a "line" is a whole paragraph, so the
// byte-identical LCS line map drops every comment on a paragraph the moment
// any sentence in it changes. A single-line anchor whose line no longer maps
// is now looked for in the diff region between its nearest mapped neighbours
// (bounded, uniqueness-gated), and its columns are carried through a
// character diff of the old line against the located line.
describe("region search (issue #269)", () => {
  const OLD_PARAGRAPH = "# T\n\nOne one. Two two. Three three.\n\nEnd";
  const withParagraph = (line: string) => `# T\n\n${line}\n\nEnd`;
  // "One one. " is 9 chars, so "Two two." starts at column 10 and ends at 18.
  const sentenceAnchor = anchor({
    sha: "old",
    range: { sl: 3, sc: 10, el: 3, ec: 18 },
    quote: "Two two.",
  });

  test("a sentence-level comment survives an edit elsewhere in the same paragraph", () => {
    const result = reanchor(
      sentenceAnchor,
      withParagraph("One one. Two two. THREE changed a lot."),
      "head",
      OLD_PARAGRAPH,
    );
    expect(result).toEqual({ status: "mapped", range: { sl: 3, sc: 10, el: 3, ec: 18 } });
  });

  test("an edit before the quote moves the columns → mapped at the new columns", () => {
    const result = reanchor(
      sentenceAnchor,
      withParagraph("Zero. One one. Two two. Three three."),
      "head",
      OLD_PARAGRAPH,
    );
    expect(result).toEqual({ status: "mapped", range: { sl: 3, sc: 16, el: 3, ec: 24 } });
  });

  test("the quote itself was edited → shifted at the char-diff-mapped columns", () => {
    const result = reanchor(
      sentenceAnchor,
      withParagraph("One one. Two TWO! Three three."),
      "head",
      OLD_PARAGRAPH,
    );
    expect(result).toEqual({ status: "shifted", range: { sl: 3, sc: 10, el: 3, ec: 18 } });
  });

  test("the paragraph was rewritten beyond the similarity floor → outdated", () => {
    const result = reanchor(
      sentenceAnchor,
      withParagraph("Completely different words that share nothing."),
      "head",
      OLD_PARAGRAPH,
    );
    expect(result).toEqual({ status: "outdated" });
  });

  test("two candidate lines contain the quote and tie on similarity → outdated", () => {
    const result = reanchor(
      anchor({ sha: "old", range: { sl: 2, sc: 1, el: 2, ec: 9 }, quote: "Two two." }),
      "a\nTwo two. x\nTwo two. y\nz",
      "head",
      "a\nTwo two.\nz",
    );
    expect(result).toEqual({ status: "outdated" });
  });

  test("a line-based suggestion anchor whose line was edited → shifted, columns stay 1/1", () => {
    const result = reanchor(
      anchor({ sha: "old", range: { sl: 2, sc: 1, el: 2, ec: 1 }, quote: "alpha beta gamma" }),
      "h\nalpha beta GAMMA\nt",
      "head",
      "h\nalpha beta gamma\nt",
    );
    expect(result).toEqual({ status: "shifted", range: { sl: 2, sc: 1, el: 2, ec: 1 } });
  });

  test("a multi-line anchor with an unmapped endpoint stays outdated", () => {
    const result = reanchor(
      anchor({ sha: "old", range: { sl: 2, sc: 1, el: 3, ec: 2 }, quote: "b\nc" }),
      "a\nB!\nc\nd",
      "head",
      "a\nb\nc\nd",
    );
    expect(result).toEqual({ status: "outdated" });
  });

  describe("region cap", () => {
    const oldSrc = "top\nneedle sentence here\nbottom";
    const needleAnchor = anchor({
      sha: "old",
      range: { sl: 2, sc: 1, el: 2, ec: 16 },
      quote: "needle sentence",
    });
    // 200 rewritten lines replace the single old line: the needle lands at a
    // configurable offset inside that region.
    const newSrcWithNeedleAt = (offset: number) => {
      const body = Array.from({ length: 200 }, (_, i) => `filler ${i + 1}`);
      body[offset - 1] = "needle sentence HERE!";
      return ["top", ...body, "bottom"].join("\n");
    };

    test("a candidate inside the capped window is found", () => {
      const result = reanchor(needleAnchor, newSrcWithNeedleAt(10), "head", oldSrc);
      expect(result).toEqual({ status: "mapped", range: { sl: 11, sc: 1, el: 11, ec: 16 } });
    });

    test("a candidate beyond the cap is never examined → outdated", () => {
      const result = reanchor(needleAnchor, newSrcWithNeedleAt(150), "head", oldSrc);
      expect(result).toEqual({ status: "outdated" });
    });
  });

  test("locateLine returns null when the old line was deleted with nothing in its place", () => {
    const oldSrc = "a\nb\nc";
    const newSrc = "a\nc";
    const located = locateLine(
      oldSrc.split("\n"),
      newSrc.split("\n"),
      buildLineMap(oldSrc, newSrc),
      2,
      "b",
    );
    expect(located).toBeNull();
  });
});
