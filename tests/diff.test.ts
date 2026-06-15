import { describe, expect, test } from "bun:test";
import { isLineInDiff, isRangeInDiff, parseRightRanges } from "../lib/diff";

const patch = [
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

describe("diff", () => {
  test("parses RIGHT-side commentable ranges", () => {
    const ranges = parseRightRanges(patch);
    expect(ranges).toEqual([
      { newStart: 1, newEnd: 4 },
      { newStart: 10, newEnd: 12 },
    ]);
  });

  test("classifies lines in/out of diff", () => {
    const ranges = parseRightRanges(patch);
    expect(isLineInDiff(ranges, 2)).toBe(true);
    expect(isLineInDiff(ranges, 4)).toBe(true); // context line
    expect(isLineInDiff(ranges, 5)).toBe(false);
    expect(isLineInDiff(ranges, 11)).toBe(true); // RIGHT stays contiguous across a deletion
  });

  test("range membership requires every line in-diff", () => {
    const ranges = parseRightRanges(patch);
    expect(isRangeInDiff(ranges, 2, 4)).toBe(true);
    expect(isRangeInDiff(ranges, 4, 6)).toBe(false);
  });

  test("undefined patch yields no ranges", () => {
    expect(parseRightRanges(undefined)).toEqual([]);
  });
});
