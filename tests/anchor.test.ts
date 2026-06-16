import { describe, expect, test } from "bun:test";
import { buildLineIndex, lineColToOffset, offsetToLineCol } from "../lib/anchor";

describe("anchor offsets", () => {
  const src = "a\nbb\nc"; // offsets: a=0 \n=1 b=2 b=3 \n=4 c=5
  const ls = buildLineIndex(src);

  test("buildLineIndex records line start offsets", () => {
    expect(ls).toEqual([0, 2, 5]);
  });

  test("offsetToLineCol maps offsets to 1-based line/col", () => {
    expect(offsetToLineCol(0, ls)).toEqual({ line: 1, col: 1 });
    expect(offsetToLineCol(3, ls)).toEqual({ line: 2, col: 2 });
    expect(offsetToLineCol(5, ls)).toEqual({ line: 3, col: 1 });
  });

  test("lineColToOffset is the inverse", () => {
    expect(lineColToOffset(1, 1, ls)).toBe(0);
    expect(lineColToOffset(2, 2, ls)).toBe(3);
    expect(lineColToOffset(3, 1, ls)).toBe(5);
  });
});
