import { describe, expect, test } from "bun:test";
import { embedMetadata, extractMetadata, type CommentMetadata } from "../lib/metadata";

const meta: CommentMetadata = {
  cid: "c-123",
  path: "docs/spec.md",
  range: { sl: 12, sc: 4, el: 14, ec: 20 },
  // Includes `--` / `-->` / Japanese / newline that would break a raw HTML comment.
  quote: "これは --- や --> を含む\n複数行の引用テキスト",
  sha: "abc1234",
  thread: "t-1",
  kind: "comment",
};

describe("metadata", () => {
  test("embed -> extract round-trips body and meta", () => {
    const body = embedMetadata("ここは曖昧では?\n直してほしい。", meta);
    const r = extractMetadata(body);
    expect(r.body).toBe("ここは曖昧では?\n直してほしい。");
    expect(r.meta).toEqual(meta);
  });

  test("emits a base64 bark:v1 marker (no raw -- in payload)", () => {
    const body = embedMetadata("x", meta);
    expect(body).toContain("<!-- bark:v1 ");
  });

  test("absent marker yields meta=null and unchanged body", () => {
    const r = extractMetadata("just a comment");
    expect(r.meta).toBeNull();
    expect(r.body).toBe("just a comment");
  });

  test("corrupt marker degrades to meta=null", () => {
    const r = extractMetadata("body\n\n<!-- bark:v1 not_valid_base64!!! -->");
    expect(r.meta).toBeNull();
  });

  test("recognizes the legacy docreview:v1 marker", () => {
    const body = embedMetadata("legacy", meta).replace("bark:v1", "docreview:v1");
    const r = extractMetadata(body);
    expect(r.meta).toEqual(meta);
    expect(r.body).toBe("legacy");
  });

  test("round-trips the resolution event field", () => {
    const ev: CommentMetadata = { ...meta, cid: "c-evt", event: "resolve" };
    const r = extractMetadata(embedMetadata("Resolved via Bark.", ev));
    expect(r.body).toBe("Resolved via Bark.");
    expect(r.meta).toEqual(ev);
  });
});
