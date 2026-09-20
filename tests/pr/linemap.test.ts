import { describe, expect, test } from "bun:test";
import { buildLineMap } from "../../lib/pr/linemap";

describe("linemap", () => {
  test("identical sources map every line to itself", () => {
    const src = "a\nb\nc";
    const map = buildLineMap(src, src);
    expect(map.get(1)).toBe(1);
    expect(map.get(2)).toBe(2);
    expect(map.get(3)).toBe(3);
  });

  test("a single insertion shifts later lines forward", () => {
    const oldS = "a\nb\nc";
    const newS = "a\nINS\nb\nc";
    const map = buildLineMap(oldS, newS);
    expect(map.get(1)).toBe(1); // a
    expect(map.get(2)).toBe(3); // b moved to line 3
    expect(map.get(3)).toBe(4); // c moved to line 4
  });

  test("a deletion drops the deleted line from the map", () => {
    const oldS = "a\nb\nc";
    const newS = "a\nc";
    const map = buildLineMap(oldS, newS);
    expect(map.get(1)).toBe(1);
    expect(map.has(2)).toBe(false); // b deleted
    expect(map.get(3)).toBe(2); // c shifted to line 2
  });

  test("a replacement drops the replaced line", () => {
    const oldS = "a\nb\nc";
    const newS = "a\nB-prime\nc";
    const map = buildLineMap(oldS, newS);
    expect(map.get(1)).toBe(1);
    expect(map.has(2)).toBe(false);
    expect(map.get(3)).toBe(3);
  });

  test("repeated identical lines map a unique pairing (LCS picks one each)", () => {
    const oldS = "a\nx\nx\nb";
    const newS = "a\nx\nx\nb";
    const map = buildLineMap(oldS, newS);
    expect(map.size).toBe(4);
  });

  test("disjoint sources produce an empty map", () => {
    const map = buildLineMap("a\nb", "c\nd");
    expect(map.size).toBe(0);
  });

  test("treats a trailing newline as a final (empty) line, matching buildLineIndex", () => {
    // "a\nb\n" is three lines: ["a","b",""] — the same view lib/anchor's
    // buildLineIndex takes, so line numbers line up with the anchor offsets.
    const map = buildLineMap("a\nb\n", "x\na\nb\n");
    expect(map.get(1)).toBe(2); // a → line 2
    expect(map.get(2)).toBe(3); // b → line 3
    expect(map.get(3)).toBe(4); // the trailing empty line is a line of its own
  });
});
