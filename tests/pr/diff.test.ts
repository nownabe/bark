import { describe, expect, test } from "bun:test";
import { buildIsInDiff, isLineInDiff, isRangeInDiff, parseRightRanges } from "../../lib/pr/diff";
import type { Comment } from "../../lib/pr/types";

const author = { login: "alice" };

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    state: "synced",
    threadId: "t1",
    body: "",
    author,
    path: "README.md",
    anchor: {
      sha: "h",
      range: { sl: 1, sc: 1, el: 1, ec: 2 },
      quote: "x",
    },
    ...overrides,
  };
}

const PATCH = [
  "@@ -1,2 +1,4 @@",
  " context line 1",
  "+added line 2",
  "+added line 3",
  " context line 4",
  "@@ -20,3 +10,3 @@",
  " ctx 10",
  "-removed left only",
  "+added 11",
  " ctx 12",
].join("\n");

describe("diff — parseRightRanges", () => {
  test("collapses contiguous additions + context into one range per hunk", () => {
    expect(parseRightRanges(PATCH)).toEqual([
      { newStart: 1, newEnd: 4 },
      { newStart: 10, newEnd: 12 },
    ]);
  });

  test("counts added lines that start with +++ (TOML front matter)", () => {
    const patch = ["@@ -0,0 +1,4 @@", "++++", '+title = "Hello"', "++++", "+Body text"].join("\n");
    expect(parseRightRanges(patch)).toEqual([{ newStart: 1, newEnd: 4 }]);
  });

  test("a removed --- line does not stop the counters for the added lines after it", () => {
    const patch = ["@@ -1,3 +1,4 @@", " intro", "----", "++++", "+normal", " outro"].join("\n");
    expect(parseRightRanges(patch)).toEqual([{ newStart: 1, newEnd: 4 }]);
  });

  test("undefined patch returns an empty range list", () => {
    expect(parseRightRanges(undefined)).toEqual([]);
  });

  test("empty patch returns an empty range list", () => {
    expect(parseRightRanges("")).toEqual([]);
  });
});

describe("diff — isLineInDiff / isRangeInDiff", () => {
  const ranges = parseRightRanges(PATCH);

  test("isLineInDiff hits inclusive bounds", () => {
    expect(isLineInDiff(ranges, 1)).toBe(true);
    expect(isLineInDiff(ranges, 4)).toBe(true);
    expect(isLineInDiff(ranges, 5)).toBe(false);
    expect(isLineInDiff(ranges, 10)).toBe(true);
    expect(isLineInDiff(ranges, 13)).toBe(false);
  });

  test("isRangeInDiff requires every line in [start, end] to be in-diff", () => {
    expect(isRangeInDiff(ranges, 1, 4)).toBe(true);
    expect(isRangeInDiff(ranges, 1, 5)).toBe(false);
    expect(isRangeInDiff(ranges, 5, 9)).toBe(false);
    expect(isRangeInDiff(ranges, 10, 12)).toBe(true);
  });
});

describe("diff — buildIsInDiff", () => {
  test("routes a comment's anchor.range through its file's parsed patch", () => {
    const isInDiff = buildIsInDiff([{ path: "README.md", status: "modified", patch: PATCH }]);
    expect(
      isInDiff(
        comment({ anchor: { sha: "h", range: { sl: 2, sc: 1, el: 3, ec: 2 }, quote: "x" } }),
      ),
    ).toBe(true);
    expect(
      isInDiff(
        comment({ anchor: { sha: "h", range: { sl: 5, sc: 1, el: 6, ec: 2 }, quote: "x" } }),
      ),
    ).toBe(false);
  });

  test("a path with no changed-file entry → out of diff", () => {
    const isInDiff = buildIsInDiff([{ path: "OTHER.md", status: "modified", patch: PATCH }]);
    expect(isInDiff(comment())).toBe(false);
  });

  test("a path with no patch (e.g. binary) → out of diff", () => {
    const isInDiff = buildIsInDiff([{ path: "README.md", status: "modified" }]);
    expect(isInDiff(comment())).toBe(false);
  });
});
