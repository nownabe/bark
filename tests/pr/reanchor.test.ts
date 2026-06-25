import { describe, expect, test } from "bun:test";
import { reanchor } from "../../lib/pr/reanchor";
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
