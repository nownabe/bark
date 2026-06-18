import { describe, expect, test } from "bun:test";
import { buildLineMap } from "../lib/linemap";

// buildLineMap(old, new) returns a 1-based old-line → new-line map containing
// only the lines that are unchanged between the two versions (matched by a
// line-level LCS). Changed/removed lines are absent.

describe("buildLineMap", () => {
  test("identical documents map every line to itself", () => {
    const doc = "a\nb\nc";
    const map = buildLineMap(doc, doc);
    expect(map.get(1)).toBe(1);
    expect(map.get(2)).toBe(2);
    expect(map.get(3)).toBe(3);
  });

  test("lines inserted above shift the following lines down", () => {
    // "a\nb" → insert two lines before → "x\ny\na\nb"
    const map = buildLineMap("a\nb", "x\ny\na\nb");
    expect(map.get(1)).toBe(3); // a: line 1 → line 3
    expect(map.get(2)).toBe(4); // b: line 2 → line 4
  });

  test("lines deleted above shift the following lines up", () => {
    // remove the first two lines
    const map = buildLineMap("x\ny\na\nb", "a\nb");
    expect(map.get(3)).toBe(1); // a: line 3 → line 1
    expect(map.get(4)).toBe(2); // b: line 4 → line 2
  });

  test("a changed line is absent from the map; its neighbours still map", () => {
    // middle line edited
    const map = buildLineMap("a\nb\nc", "a\nB\nc");
    expect(map.get(1)).toBe(1); // a unchanged
    expect(map.has(2)).toBe(false); // b → B is a change, not a match
    expect(map.get(3)).toBe(3); // c unchanged (no net line shift)
  });

  test("an insertion in the middle shifts only the lines after it", () => {
    // "a\nb\nc" → insert a line between b and c → "a\nb\nX\nc"
    const map = buildLineMap("a\nb\nc", "a\nb\nX\nc");
    expect(map.get(1)).toBe(1);
    expect(map.get(2)).toBe(2);
    expect(map.get(3)).toBe(4); // c shifted past the inserted line
  });

  test("treats a trailing newline as a final (empty) line, matching buildLineIndex", () => {
    // "a\nb\n" is three lines: ["a","b",""] — same view buildLineIndex takes.
    const map = buildLineMap("a\nb\n", "x\na\nb\n");
    expect(map.get(1)).toBe(2); // a → line 2
    expect(map.get(2)).toBe(3); // b → line 3
  });
});
