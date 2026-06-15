import { describe, expect, test } from "bun:test";
import { buildLineIndex } from "../lib/anchor";
import { reanchorComment } from "../lib/reanchor";
import type { CommentMetadata } from "../lib/metadata";

const meta: CommentMetadata = {
  cid: "c1",
  path: "d.md",
  range: { sl: 2, sc: 5, el: 2, ec: 10 }, // "quick"
  quote: "quick",
  sha: "sha-original",
  thread: "t1",
};

describe("reanchor", () => {
  test("same head SHA keeps the stored position (current)", () => {
    const src = "line one\nthe quick brown fox\nline three\n";
    const r = reanchorComment(src, buildLineIndex(src), meta, "sha-original");
    expect(r.status).toBe("current");
    expect(src.slice(r.startOffset, r.endOffset)).toBe("quick");
  });

  test("shifted source re-finds the quote (reanchored)", () => {
    const src = "NEW HEADER\n\nline one\nthe quick brown fox\nline three\n";
    const r = reanchorComment(src, buildLineIndex(src), meta, "sha-new");
    expect(r.status).toBe("reanchored");
    expect(src.slice(r.startOffset, r.endOffset)).toBe("quick");
  });

  test("missing quote is outdated", () => {
    const src = "line one\nthe slow green turtle\nline three\n";
    const r = reanchorComment(src, buildLineIndex(src), meta, "sha-new");
    expect(r.status).toBe("outdated");
  });
});
