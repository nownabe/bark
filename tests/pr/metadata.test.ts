import { describe, expect, test } from "bun:test";
import { embedMetadata, extractMetadata, type WireMetadata } from "../../lib/pr/metadata";

function meta(overrides: Partial<WireMetadata> = {}): WireMetadata {
  return {
    cid: "c1",
    threadId: "t1",
    path: "README.md",
    anchor: {
      sha: "deadbeef",
      range: { sl: 1, sc: 1, el: 2, ec: 10 },
      quote: "hello world",
    },
    ...overrides,
  };
}

describe("metadata — round trip", () => {
  test("embed then extract recovers the metadata exactly", () => {
    const m = meta();
    const body = embedMetadata("Some comment text", m);
    const { body: visible, meta: parsed } = extractMetadata(body);
    expect(parsed).toEqual(m);
    expect(visible).toBe("Some comment text");
  });

  test("embeds a fence at the end of the body, separated by a blank line", () => {
    const body = embedMetadata("hi", meta());
    expect(body.startsWith("hi\n\n<!--")).toBe(true);
    expect(body.endsWith("-->")).toBe(true);
  });

  test("trailing whitespace on the input body is trimmed before embedding", () => {
    const body = embedMetadata("hi   \n  \n", meta());
    // No spurious whitespace between visible content and fence.
    expect(body.startsWith("hi\n\n<!--")).toBe(true);
  });

  test("empty body produces a fence-only payload (no leading newlines)", () => {
    const body = embedMetadata("", meta());
    expect(body.startsWith("<!--")).toBe(true);
  });

  test("non-ASCII characters in the body and quote round-trip", () => {
    const m = meta({ anchor: { ...meta().anchor, quote: "こんにちは 🎉" } });
    const body = embedMetadata("レビューします", m);
    const { body: visible, meta: parsed } = extractMetadata(body);
    expect(visible).toBe("レビューします");
    expect(parsed).toEqual(m);
  });
});

describe("metadata — extraction edge cases", () => {
  test("a body without a fence yields { meta: null } and the original body", () => {
    const out = extractMetadata("Just a comment.");
    expect(out.meta).toBeNull();
    expect(out.body).toBe("Just a comment.");
  });

  test("a legacy bark:v1 fence is upgraded to the v2 shape (thread -> threadId, anchor reshape)", () => {
    const v1 = {
      cid: "c-1",
      thread: "t-1",
      path: "src/x.md",
      sha: "abcdef",
      quote: "hello",
      range: { sl: 5, sc: 1, el: 5, ec: 6 },
      kind: "comment",
    };
    const encoded = btoa(JSON.stringify(v1));
    const out = extractMetadata(`body\n\n<!-- bark:v1 ${encoded} -->`);
    expect(out.meta).toEqual({
      cid: "c-1",
      threadId: "t-1",
      path: "src/x.md",
      anchor: {
        sha: "abcdef",
        range: { sl: 5, sc: 1, el: 5, ec: 6 },
        quote: "hello",
      },
    });
    expect(out.body).toBe("body");
  });

  test("the legacy 'docreview:v1' marker alias is also accepted", () => {
    const v1 = {
      cid: "c-2",
      thread: "t-2",
      path: "x.md",
      sha: "h",
      quote: "q",
      range: { sl: 1, sc: 1, el: 1, ec: 2 },
    };
    const encoded = btoa(JSON.stringify(v1));
    const out = extractMetadata(`body\n\n<!-- docreview:v1 ${encoded} -->`);
    expect(out.meta?.threadId).toBe("t-2");
  });

  test("a malformed v1 payload (missing required field) yields { meta: null }", () => {
    const broken = { cid: "c", path: "p", sha: "s", quote: "q" }; // no thread, no range
    const encoded = btoa(JSON.stringify(broken));
    const out = extractMetadata(`body\n\n<!-- bark:v1 ${encoded} -->`);
    expect(out.meta).toBeNull();
  });

  test("a corrupt base64 payload yields { meta: null }", () => {
    const out = extractMetadata("body\n\n<!-- bark:v2 !!!notbase64!!! -->");
    expect(out.meta).toBeNull();
    expect(out.body).toBe("body\n\n<!-- bark:v2 !!!notbase64!!! -->");
  });

  test("a payload with the wrong shape yields { meta: null }", () => {
    // Valid base64 but the decoded JSON is missing required fields.
    const encoded = btoa('{"cid":"only-cid"}');
    const out = extractMetadata(`body\n\n<!-- bark:v2 ${encoded} -->`);
    expect(out.meta).toBeNull();
  });

  test("only the trailing fence is recognised (no greedy mid-body match)", () => {
    const m = meta();
    const body = embedMetadata("body\n\n<!-- bark:v2 oldfake -->\nmore body", m);
    // The trailing fence (the one embed added) wins.
    const out = extractMetadata(body);
    expect(out.meta).toEqual(m);
    expect(out.body).toBe("body\n\n<!-- bark:v2 oldfake -->\nmore body");
  });
});
