import { describe, expect, test } from "bun:test";
import {
  BODY_LIMIT,
  composeIssueCommentBody,
  contentDigest,
  embedMetadata,
  envelopeOf,
  extractMetadata,
  QUOTE_EXCERPT_CHARS,
  quoteBlock,
  type WireMetadata,
  wireBodyLength,
} from "../../lib/pr/metadata";
import type { Comment } from "../../lib/pr/types";

describe("quoteBlock (issue #279)", () => {
  test("a short quote becomes one blockquote line per source line, with no trailer", () => {
    expect(quoteBlock("a\nb\nc")).toBe("> a\n> b\n> c");
  });

  test("a long quote is cut to 12 lines and marked as an excerpt", () => {
    const lines = quoteBlock(
      Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"),
    ).split("\n");
    expect(lines).toHaveLength(13);
    expect(lines[11]).toBe("> line 12");
    expect(lines[12]).toBe("> …");
  });

  test("a single line over the character cap is cut too", () => {
    const out = quoteBlock("z".repeat(5000));
    expect(out.length).toBeLessThan(1100);
    expect(out.endsWith("\n> …")).toBe(true);
  });
});

describe("composeIssueCommentBody (issue #282)", () => {
  const ref = { owner: "o", repo: "r", number: 7 };
  const base: Comment = {
    id: "c1",
    state: "draft",
    threadId: "t1",
    body: "typo here",
    author: { login: "alice" },
    path: "docs/a b.md",
    anchor: { sha: "h0", range: { sl: 3, sc: 1, el: 3, ec: 5 }, quote: "abcd" },
  };

  test("appends the quoted excerpt and a permalink to the raw text", () => {
    expect(composeIssueCommentBody(base, ref)).toBe(
      "typo here\n\n> abcd\nhttps://github.com/o/r/blob/h0/docs/a%20b.md#L3",
    );
  });

  test("an anchor with nothing to quote or link leaves the text alone", () => {
    const bare = { ...base, anchor: { sha: "", range: base.anchor.range, quote: "" } };
    expect(composeIssueCommentBody(bare, ref)).toBe("typo here");
  });
});

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

  test("a legacy line-based v2 anchor is normalised at parse (issue #276)", () => {
    const body = embedMetadata(
      "body",
      meta({
        anchor: { sha: "old", range: { sl: 3, sc: 1, el: 3, ec: 1 }, quote: "alpha beta" },
      }),
    );
    expect(extractMetadata(body).meta?.anchor.range.ec).toBe(11);
  });

  test("a legacy line-based v1 anchor is normalised at parse (issue #276)", () => {
    const v1 = {
      cid: "c-1",
      thread: "t-1",
      path: "x.md",
      sha: "old",
      quote: "alpha beta",
      range: { sl: 3, sc: 1, el: 3, ec: 1 },
    };
    const encoded = btoa(JSON.stringify(v1));
    const out = extractMetadata(`body\n\n<!-- bark:v1 ${encoded} -->`);
    expect(out.meta?.anchor.range.ec).toBe(11);
  });

  test("a v1 resolve marker keeps its event as legacyResolveEvent (issue #186)", () => {
    const v1 = {
      cid: "e-1",
      thread: "t-1",
      path: "x.md",
      sha: "h",
      quote: "q",
      range: { sl: 1, sc: 1, el: 1, ec: 2 },
      event: "resolve",
    };
    const encoded = btoa(JSON.stringify(v1));
    const out = extractMetadata(`Resolved via Bark.\n\n<!-- bark:v1 ${encoded} -->`);
    expect(out.meta?.legacyResolveEvent).toBe("resolve");
  });

  test("a v1 fence without event has no legacyResolveEvent", () => {
    const v1 = {
      cid: "c-1",
      thread: "t-1",
      path: "x.md",
      sha: "h",
      quote: "q",
      range: { sl: 1, sc: 1, el: 1, ec: 2 },
    };
    const encoded = btoa(JSON.stringify(v1));
    const out = extractMetadata(`body\n\n<!-- bark:v1 ${encoded} -->`);
    expect(out.meta?.legacyResolveEvent).toBeUndefined();
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

describe("metadata — bounded quote (issue #279)", () => {
  const longQuote = "q".repeat(5000);
  /** The fence payload as it went on the wire. */
  const decodeFence = (body: string): Record<string, unknown> => {
    const payload = /<!-- bark:v2 ([A-Za-z0-9+/=]+) -->$/.exec(body)?.[1] ?? "";
    return JSON.parse(atob(payload)) as Record<string, unknown>;
  };

  test("contentDigest is stable, and different inputs differ", () => {
    expect(contentDigest("a")).toBe(contentDigest("a"));
    expect(contentDigest("a")).not.toBe(contentDigest(""));
    expect(contentDigest("x".repeat(2000))).not.toBe(contentDigest(`${"x".repeat(1999)}y`));
  });

  test("a quote over the excerpt cap is truncated and described by digest + length", () => {
    const body = embedMetadata("hi", meta({ anchor: { ...meta().anchor, quote: longQuote } }));
    const wire = decodeFence(body);
    expect((wire.anchor as { quote: string }).quote.length).toBe(QUOTE_EXCERPT_CHARS);
    expect(wire.quoteLength).toBe(5000);
    expect(wire.quoteDigest).toBe(contentDigest(longQuote));
  });

  test("a quote at or under the cap keeps the fence byte-identical to before", () => {
    const wire = decodeFence(embedMetadata("hi", meta()));
    expect(wire).not.toHaveProperty("quoteDigest");
    expect(wire).not.toHaveProperty("quoteLength");
  });

  test("extractMetadata surfaces the digest and length of a capped fence", () => {
    const body = embedMetadata("hi", meta({ anchor: { ...meta().anchor, quote: longQuote } }));
    const parsed = extractMetadata(body).meta;
    expect(parsed?.quoteLength).toBe(5000);
    expect(parsed?.quoteDigest).toBe(contentDigest(longQuote));
    expect(parsed?.anchor.quote.length).toBe(QUOTE_EXCERPT_CHARS);
  });

  test("a 100 KB selection produces a wire body under GitHub's limit", () => {
    const hugeQuote = "z".repeat(100_000);
    const comment: Comment = {
      id: "c1",
      state: "draft",
      threadId: "t1",
      body: "please restructure",
      author: { login: "alice" },
      path: "README.md",
      anchor: { sha: "h", range: { sl: 1, sc: 1, el: 1, ec: 100_001 }, quote: hugeQuote },
    };
    expect(wireBodyLength(comment.body, envelopeOf(comment))).toBeLessThan(BODY_LIMIT);
  });
});

describe("metadata — resolved flag (issue #270)", () => {
  test("the v2 envelope round-trips `resolved` and coerces non-booleans", () => {
    const withTrue = embedMetadata("Body", meta({ resolved: true }));
    expect(extractMetadata(withTrue).meta?.resolved).toBe(true);
    expect(extractMetadata(withTrue).body).toBe("Body");

    // A stray non-boolean must not demote a real Bark comment to foreign;
    // it simply reads as "not resolved".
    const withYes = `Body\n\n<!-- bark:v2 ${btoa(JSON.stringify({ ...meta(), resolved: "yes" }))} -->`;
    const parsedYes = extractMetadata(withYes);
    expect(parsedYes.meta).not.toBeNull();
    expect(parsedYes.meta?.resolved).toBeUndefined();
    expect(parsedYes.body).toBe("Body");

    const withoutKey = embedMetadata("Body", meta());
    expect(extractMetadata(withoutKey).meta?.resolved).toBeUndefined();
    expect(extractMetadata(withoutKey).body).toBe("Body");
  });
});
