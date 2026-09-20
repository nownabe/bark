import { describe, expect, test } from "bun:test";
import { buildLineMap, lineDiff, lineMapFor } from "../../lib/pr/linemap";

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

describe("linemap — lineDiff", () => {
  test("a modified line is a delete and an insert between the kept lines", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "B", "c"])).toEqual([
      { op: 0, text: "a" },
      { op: -1, text: "b" },
      { op: 1, text: "B" },
      { op: 0, text: "c" },
    ]);
  });

  test("an insertion into an empty document is a single insert", () => {
    expect(lineDiff([], ["x"])).toEqual([{ op: 1, text: "x" }]);
  });

  test("identical inputs keep every line", () => {
    expect(lineDiff(["a", "b"], ["a", "b"])).toEqual([
      { op: 0, text: "a" },
      { op: 0, text: "b" },
    ]);
  });

  // The one-code-unit-per-line encoding tops out at 65,535 distinct lines
  // (ADR 0004 §5): beyond it nothing is kept, so every anchor is `outdated`.
  test("more than 65,535 distinct lines keep nothing", () => {
    const lines = Array.from({ length: 66_000 }, (_, i) => `line ${i}`);
    const oldSource = lines.join("\n");
    expect(buildLineMap(oldSource, `${oldSource}\nlast`).size).toBe(0);
  });
});

describe("linemap — lineMapFor", () => {
  test("the same key and sources return the same map instance", () => {
    const key = { oldSha: "o", newSha: "n", path: "memo.md" };
    expect(lineMapFor(key, "a\nb\nc", "a\nB\nc")).toBe(lineMapFor(key, "a\nb\nc", "a\nB\nc"));
  });

  test("a reused key with different sources rebuilds instead of serving a stale map", () => {
    const key = { oldSha: "o", newSha: "n", path: "stale.md" };
    const first = lineMapFor(key, "a\nb\nc", "a\nb\nc");
    expect(first.get(2)).toBe(2);
    const second = lineMapFor(key, "a\nb\nc", "a\nB\nc");
    expect(second).not.toBe(first);
    expect(second.has(2)).toBe(false);
  });

  test("the LRU evicts the oldest entry beyond its capacity", () => {
    const key = { oldSha: "o", newSha: "n", path: "lru-0.md" };
    const first = lineMapFor(key, "a", "a");
    for (let i = 1; i <= 70; i++) {
      lineMapFor({ oldSha: "o", newSha: "n", path: `lru-${i}.md` }, "a", "a");
    }
    expect(lineMapFor(key, "a", "a")).not.toBe(first);
  });
});
