// Embedded-metadata codec.
//
// Append an invisible "tool-only" marker (an HTML comment) to the end of a
// review comment body so the tool can fully restore char-level anchors, threads,
// and state. On GitHub it is an HTML comment (hidden) and harmless without the tool.
//
// Improvement over the design: HTML comments cannot contain `--`, so a raw JSON
// payload breaks when quotedText contains `--` (e.g. `---`). The JSON is therefore
// UTF-8-safe base64 encoded (non-ASCII quotes are safe too).

/** Range in the source (start/end line・col). */
export interface AnchorRange {
  sl: number;
  sc: number;
  el: number;
  ec: number;
}

/** Structured metadata embedded in a comment body. */
export interface CommentMetadata {
  /** comment id (local uuid). */
  cid: string;
  path: string;
  range: AnchorRange;
  /** quoted text used for re-anchoring. */
  quote: string;
  /** which source revision the comment was made against (createdAtSha). */
  sha: string;
  /** conversation grouping (threadId). */
  thread: string;
  /** comment | suggestion. Treated as comment when omitted. */
  kind?: "comment" | "suggestion";
  /** Set only on resolution-marker comments; toggles a thread's resolved state. */
  event?: "resolve" | "unresolve";
}

const MARKER = "bark:v1";
// Emit `bark:v1`; also recognize the legacy `docreview:v1` for backward compatibility.
const MARKER_RE = /\n*<!--\s*(?:bark|docreview):v1\s+([A-Za-z0-9+/=]+)\s*-->\s*$/;

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Append the invisible metadata marker to the end of the visible body. */
export function embedMetadata(visibleBody: string, meta: CommentMetadata): string {
  const payload = toBase64(JSON.stringify(meta));
  return `${visibleBody.trimEnd()}\n\n<!-- ${MARKER} ${payload} -->`;
}

/**
 * Extract metadata from a comment body and split off the visible text.
 * If the marker is missing or corrupt, meta is null (degrade to line anchor).
 */
export function extractMetadata(body: string): { body: string; meta: CommentMetadata | null } {
  const m = body.match(MARKER_RE);
  if (!m || m.index == null) return { body, meta: null };
  try {
    const meta = JSON.parse(fromBase64(m[1])) as CommentMetadata;
    return { body: body.slice(0, m.index).trimEnd(), meta };
  } catch {
    return { body, meta: null };
  }
}
