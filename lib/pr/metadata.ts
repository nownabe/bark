// Hidden-metadata wire format. Used by the Executor to round-trip a
// Comment's local identity (cid, threadId, anchor) through GitHub: the
// metadata is embedded in the posted comment body as a trailing
// HTML comment, then extracted on fetch.
//
// Marker: "bark:v2". Older "bark:v1" payloads are intentionally
// discarded — per ADR 0003 §7 Bark is pre-release and legacy data is
// not migrated.

import type { Anchor } from "./types";

const MARKER = "bark:v2";
const FENCE_RE = /\n*<!--\s+bark:v2\s+([A-Za-z0-9+/=]+)\s+-->\s*$/;

export type WireMetadata = {
  cid: string;
  threadId: string;
  /** Comment.path — included so out-of-diff comments (issue comments) can
   *  round-trip their path even though GitHub does not store it natively. */
  path: string;
  anchor: Anchor;
};

/** Append the metadata fence to a comment body. */
export function embedMetadata(body: string, meta: WireMetadata): string {
  const encoded = base64Encode(JSON.stringify(meta));
  const trimmed = body.replace(/\s*$/, "");
  const separator = trimmed === "" ? "" : "\n\n";
  return `${trimmed}${separator}<!-- ${MARKER} ${encoded} -->`;
}

/** Split a comment body into its visible portion and the parsed metadata.
 *  Returns `meta: null` for foreign comments, legacy markers, or any
 *  payload that fails to validate as `WireMetadata`. */
export function extractMetadata(body: string): {
  body: string;
  meta: WireMetadata | null;
} {
  const match = FENCE_RE.exec(body);
  if (!match) return { body, meta: null };
  const payload = match[1];
  if (!payload) return { body, meta: null };
  try {
    const parsed = JSON.parse(base64Decode(payload)) as unknown;
    if (!isValidWireMetadata(parsed)) {
      return { body, meta: null };
    }
    const cleaned = body.slice(0, match.index).replace(/\s*$/, "");
    return { body: cleaned, meta: parsed };
  } catch {
    return { body, meta: null };
  }
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
