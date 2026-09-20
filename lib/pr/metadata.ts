// Hidden-metadata wire format. Used by the Executor to round-trip a
// Comment's local identity (cid, threadId, anchor) through GitHub: the
// metadata is embedded in the posted comment body as a trailing
// HTML comment, then extracted on fetch.
//
// Write format: "bark:v2".
//
// Read format: "bark:v2" preferred, "bark:v1" (and the original
// "docreview:v1" alias) accepted as backward compatibility. ADR 0003 §7
// says legacy *local* data isn't migrated — but comment metadata lives
// on github.com, where it CAN'T be migrated, so the new fetcher has to
// keep reading it. v1 → v2 mapping rewrites field names and reshapes
// the anchor inline; `kind` is re-derived from the body downstream. v2
// represents resolved state on the Thread entity, so `event` is not part
// of v2 — but v1 `event` is kept as `legacyResolveEvent` so the fetcher
// can recognise and drop legacy resolve-marker comments (issue #186).

import { buildBlobPermalink } from "../github";
import { type Anchor, type Comment, normalizeAnchor, type PrRef } from "./types";

const MARKER = "bark:v2";

/** GitHub rejects a comment body longer than this (REST, 422). */
export const BODY_LIMIT = 65_536;
/** Most `quote` characters the fence carries. Beyond it the envelope keeps an
 *  excerpt plus `quoteDigest`/`quoteLength` and the fetcher restores the full
 *  text from the file content at `(anchor.sha, path)` (issue #279). */
export const QUOTE_EXCERPT_CHARS = 1000;
const FENCE_RE_V2 = /\n*<!--\s+bark:v2\s+([A-Za-z0-9+/=]+)\s+-->\s*$/;
const FENCE_RE_V1 = /\n*<!--\s*(?:bark|docreview):v1\s+([A-Za-z0-9+/=]+)\s*-->\s*$/;

export type WireMetadata = {
  cid: string;
  threadId: string;
  /** Comment.path — included so out-of-diff comments (issue comments) can
   *  round-trip their path even though GitHub does not store it natively. */
  path: string;
  anchor: Anchor;
  /** Out-of-diff threads only: resolved state of the thread whose root this
   *  comment is (issue #270). Ignored on review comments (GraphQL isResolved
   *  wins) and on any comment that is not the earliest bearer of `threadId`. */
  resolved?: boolean;
  /** Set only when `anchor.quote` was capped: digest and length of the FULL
   *  quote, so the fetcher can restore it and verify the restoration. */
  quoteDigest?: string;
  quoteLength?: number;
  /** Read-only, v1 only. Legacy Bark resolved a thread by posting a hidden
   *  marker comment ("Resolved via Bark." / "Reopened via Bark.") carrying
   *  `event` in its v1 fence. v2 represents resolved state on the Thread
   *  entity and never writes this. When set, the comment is a resolution
   *  marker, not a real message — the fetcher drops it so it doesn't render
   *  as a thread reply (issue #186). */
  legacyResolveEvent?: "resolve" | "unresolve";
};

/** The envelope the Executor posts for a Comment. One definition, so the
 *  Planner's size check measures exactly what the transport will send. */
export function envelopeOf(c: Comment): WireMetadata {
  return { cid: c.id, threadId: c.threadId, path: c.path, anchor: c.anchor };
}

/** Length of the body that would go on the wire, for GitHub's 65,536-character
 *  limit. */
export function wireBodyLength(body: string, meta: WireMetadata): number {
  return embedMetadata(body, meta).length;
}

/** Most quoted lines an out-of-diff comment shows before the `> …` trailer. */
const QUOTE_BLOCK_LINES = 12;

/** Render an anchor's quote as the Markdown blockquote an out-of-diff comment
 *  shows above its permalink. The quote can be a whole chapter, and GitHub
 *  caps a body at 65,536 characters, so the block is an excerpt (issue #279);
 *  the full quote stays in LocalState and in the anchor. */
export function quoteBlock(quote: string): string {
  const lines = quote.slice(0, QUOTE_EXCERPT_CHARS).split("\n").slice(0, QUOTE_BLOCK_LINES);
  const block = lines.map((l) => `> ${l}`).join("\n");
  const complete = lines.join("\n").length === quote.length;
  return complete ? block : `${block}\n> …`;
}

/** The visible body of an out-of-diff post: the author's text, the lines it was
 *  written on, and a permalink to them.
 *
 *  A GitHub review comment carries its own position; an issue comment does not,
 *  so without this a reader on github.com sees the words and nothing else
 *  (issue #282). It is composed here rather than stored on `Comment.body` so
 *  LocalState keeps the raw text — one definition, so the Planner's size check
 *  measures exactly what the Transport will send. */
export function composeIssueCommentBody(c: Comment, ref: PrRef): string {
  const { sl, el } = c.anchor.range;
  const context = [
    c.anchor.quote === "" ? "" : quoteBlock(c.anchor.quote),
    c.anchor.sha === "" ? "" : buildBlobPermalink(ref, c.path, c.anchor.sha, sl, el),
  ].filter(Boolean);
  return context.length === 0 ? c.body : `${c.body}\n\n${context.join("\n")}`;
}

/** Append the metadata fence to a comment body. A quote longer than
 *  {@link QUOTE_EXCERPT_CHARS} travels as an excerpt plus digest and length;
 *  a shorter one produces the same bytes as before the cap existed. */
export function embedMetadata(body: string, meta: WireMetadata): string {
  const quote = meta.anchor.quote;
  const payload =
    quote.length > QUOTE_EXCERPT_CHARS
      ? {
          ...meta,
          anchor: { ...meta.anchor, quote: quote.slice(0, QUOTE_EXCERPT_CHARS) },
          quoteDigest: contentDigest(quote),
          quoteLength: quote.length,
        }
      : meta;
  const encoded = base64Encode(JSON.stringify(payload));
  const trimmed = body.replace(/\s*$/, "");
  const separator = trimmed === "" ? "" : "\n\n";
  return `${trimmed}${separator}<!-- ${MARKER} ${encoded} -->`;
}

/** cyrb53: a sync, dependency-free 53-bit content hash, rendered as 14 hex
 *  characters.
 *
 *  Why not SHA-256 via Web Crypto: `crypto.subtle.digest` is async, which
 *  would make `embedMetadata` — and its four transport call sites and every
 *  fence fixture — async for no security gain. The digest guards against
 *  mis-restoration (wrong range, corrupt fence), not against an attacker, who
 *  can already rewrite any fence field; identity trust is the earliest-bearer
 *  rule (issue #190). Never use it for a security decision. */
export function contentDigest(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** Split a comment body into its visible portion and the parsed metadata.
 *  Returns `meta: null` for foreign comments or any payload that fails
 *  to validate. Tries the v2 fence first; falls back to v1 (`bark:v1`
 *  and the legacy `docreview:v1` alias) so comments posted by the
 *  legacy App are still recognised after the data-layer rewrite. */
export function extractMetadata(body: string): {
  body: string;
  meta: WireMetadata | null;
} {
  const v2 = readFence(body, FENCE_RE_V2, parseV2);
  if (v2) return v2;
  const v1 = readFence(body, FENCE_RE_V1, parseV1);
  if (v1) return v1;
  return { body, meta: null };
}

function readFence(
  body: string,
  re: RegExp,
  parse: (payload: string) => WireMetadata | null,
): { body: string; meta: WireMetadata } | null {
  const match = re.exec(body);
  if (!match) return null;
  const payload = match[1];
  if (!payload) return null;
  try {
    const decoded = base64Decode(payload);
    const parsed = parse(decoded);
    if (!parsed) return null;
    const cleaned = body.slice(0, match.index).replace(/\s*$/, "");
    return { body: cleaned, meta: parsed };
  } catch {
    return null;
  }
}

function parseV2(decoded: string): WireMetadata | null {
  const value: unknown = JSON.parse(decoded);
  if (!isValidWireMetadata(value)) return null;
  // A non-boolean `resolved` reads as "not resolved" rather than as an
  // invalid payload — a stray field must not demote a real Bark comment to
  // foreign (issue #270).
  const { resolved, quoteDigest, quoteLength, ...rest } = value;
  // Both halves of the restoration key or neither: a half-written pair would
  // make the fetcher trust an unverified quote (issue #279).
  const capped =
    typeof quoteDigest === "string" && typeof quoteLength === "number"
      ? { quoteDigest, quoteLength }
      : {};
  const meta = { ...rest, anchor: normalizeAnchor(rest.anchor), ...capped };
  return resolved === true ? { ...meta, resolved: true } : meta;
}

/** v1 payload shape (lib/metadata.ts in the legacy App):
 *  `{ cid, path, range, quote, sha, thread, kind?, event? }`. */
function parseV1(decoded: string): WireMetadata | null {
  const v = JSON.parse(decoded) as unknown;
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  if (
    typeof m.cid !== "string" ||
    typeof m.thread !== "string" ||
    typeof m.path !== "string" ||
    typeof m.sha !== "string" ||
    typeof m.quote !== "string"
  )
    return null;
  if (!m.range || typeof m.range !== "object") return null;
  const r = m.range as Record<string, unknown>;
  if (
    typeof r.sl !== "number" ||
    typeof r.sc !== "number" ||
    typeof r.el !== "number" ||
    typeof r.ec !== "number"
  )
    return null;
  // Drop `kind` (re-derived from body downstream). Keep `event` as
  // `legacyResolveEvent` so the fetcher can recognise and drop legacy
  // resolution-marker comments (v2 carries resolved state on Thread).
  const legacyResolveEvent = m.event === "resolve" || m.event === "unresolve" ? m.event : undefined;
  return {
    cid: m.cid,
    threadId: m.thread,
    path: m.path,
    anchor: normalizeAnchor({
      sha: m.sha,
      range: { sl: r.sl, sc: r.sc, el: r.el, ec: r.ec },
      quote: m.quote,
    }),
    ...(legacyResolveEvent ? { legacyResolveEvent } : {}),
  };
}

function isValidWireMetadata(x: unknown): x is WireMetadata {
  if (!x || typeof x !== "object") return false;
  const m = x as Record<string, unknown>;
  if (typeof m.cid !== "string" || typeof m.threadId !== "string") return false;
  if (typeof m.path !== "string") return false;
  if (!m.anchor || typeof m.anchor !== "object") return false;
  const a = m.anchor as Record<string, unknown>;
  if (typeof a.sha !== "string" || typeof a.quote !== "string") return false;
  if (!a.range || typeof a.range !== "object") return false;
  const r = a.range as Record<string, unknown>;
  return (
    typeof r.sl === "number" &&
    typeof r.sc === "number" &&
    typeof r.el === "number" &&
    typeof r.ec === "number"
  );
}

// ---- base64 helpers (UTF-8 safe) ----------------------------------------

function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decode base64 to a UTF-8 string. Shared with the remote fetcher, which
 *  decodes GitHub's file contents with it. */
export function base64Decode(s: string): string {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
