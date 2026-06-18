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

describe("reanchor (diff-based, with the createdAtSha source)", () => {
  const oldSrc = "line one\nthe quick brown fox\nline three\n";

  test("a confident diff mapping is current (no shift warning), even when the line moved", () => {
    // The diff resolves the anchor exactly, so the position is known-good — we
    // don't flag it as "position shifted" merely because the line number moved.
    const src = "NEW HEADER\n\nline one\nthe quick brown fox\nline three\n";
    const r = reanchorComment(src, buildLineIndex(src), meta, "sha-new", oldSrc);
    expect(r.status).toBe("current");
    expect(src.slice(r.startOffset, r.endOffset)).toBe("quick");
  });

  test("unchanged position is current at a new SHA", () => {
    const src = oldSrc;
    const r = reanchorComment(src, buildLineIndex(src), meta, "sha-new", oldSrc);
    expect(r.status).toBe("current");
    expect(src.slice(r.startOffset, r.endOffset)).toBe("quick");
  });

  test("anchors to the correct line (current) when the quote also appears elsewhere", () => {
    const old2 = "intro\nthe quick brown fox\nmiddle\n";
    const meta2: CommentMetadata = { ...meta, range: { sl: 2, sc: 5, el: 2, ec: 10 } };
    // A decoy "quick" line is inserted above; the diff must still anchor to the
    // original line (now line 3), not the decoy — and trust it (current).
    const src = "a quick fox\nintro\nthe quick brown fox\nmiddle\n";
    const r = reanchorComment(src, buildLineIndex(src), meta2, "sha-new", old2);
    expect(r.status).toBe("current");
    expect(src.slice(r.startOffset, r.endOffset)).toBe("quick");
    // The 4 chars before the match are "the " — i.e. the original line, not the
    // decoy "a quick fox" (whose prefix is only "a ").
    expect(src.slice(r.startOffset - 4, r.startOffset + 5)).toBe("the quick");
  });

  test("falls back to quote search (reanchored) when the anchored line was edited", () => {
    // The line changed (no diff match), but the quote still occurs on it. This is
    // the uncertain, heuristic path — flag it as "position shifted".
    const src = "line one\nthe quick red fox\nline three\n";
    const r = reanchorComment(src, buildLineIndex(src), meta, "sha-new", oldSrc);
    expect(r.status).toBe("reanchored");
    expect(src.slice(r.startOffset, r.endOffset)).toBe("quick");
  });

  test("is outdated when the target text is gone, even with the old source", () => {
    const src = "line one\nthe slow green turtle\nline three\n";
    const r = reanchorComment(src, buildLineIndex(src), meta, "sha-new", oldSrc);
    expect(r.status).toBe("outdated");
  });
});
