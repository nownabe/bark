import { describe, expect, test } from "bun:test";
import { embedMetadata, extractMetadata, type WireMetadata } from "../../lib/pr/metadata";

function meta(overrides: Partial<WireMetadata> = {}): WireMetadata {
  return {
    cid: "c1",
    threadId: "t1",
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

  test("a legacy v1 marker is ignored (treated as foreign)", () => {
    const out = extractMetadata("body\n\n<!-- bark:v1 SOMEPAYLOAD -->");
    expect(out.meta).toBeNull();
    expect(out.body).toBe("body\n\n<!-- bark:v1 SOMEPAYLOAD -->");
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
