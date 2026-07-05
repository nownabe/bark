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

import type { Anchor } from "./types";

const MARKER = "bark:v2";
const FENCE_RE_V2 = /\n*<!--\s+bark:v2\s+([A-Za-z0-9+/=]+)\s+-->\s*$/;
const FENCE_RE_V1 = /\n*<!--\s*(?:bark|docreview):v1\s+([A-Za-z0-9+/=]+)\s*-->\s*$/;

export type WireMetadata = {
  cid: string;
  threadId: string;
  /** Comment.path — included so out-of-diff comments (issue comments) can
   *  round-trip their path even though GitHub does not store it natively. */
  path: string;
  anchor: Anchor;
  /** Read-only, v1 only. Legacy Bark resolved a thread by posting a hidden
   *  marker comment ("Resolved via Bark." / "Reopened via Bark.") carrying
   *  `event` in its v1 fence. v2 represents resolved state on the Thread
   *  entity and never writes this. When set, the comment is a resolution
   *  marker, not a real message — the fetcher drops it so it doesn't render
   *  as a thread reply (issue #186). */
  legacyResolveEvent?: "resolve" | "unresolve";
};

/** Append the metadata fence to a comment body. */
export function embedMetadata(body: string, meta: WireMetadata): string {
  const encoded = base64Encode(JSON.stringify(meta));
  const trimmed = body.replace(/\s*$/, "");
  const separator = trimmed === "" ? "" : "\n\n";
  return `${trimmed}${separator}<!-- ${MARKER} ${encoded} -->`;
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
  return isValidWireMetadata(value) ? value : null;
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
    anchor: {
      sha: m.sha,
      range: { sl: r.sl, sc: r.sc, el: r.el, ec: r.ec },
      quote: m.quote,
    },
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

function base64Decode(s: string): string {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
