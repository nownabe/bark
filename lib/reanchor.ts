// Re-anchoring — Design Doc §7.8 / R7.
//
// When head advances to a new commit, the line/col stored on a comment (as of createdAtSha)
// can drift from the current source. If createdAtSha matches the current head, use the stored
// values as-is; otherwise re-resolve by matching quotedText against the current source. If not
// found, it's outdated.
// v1 uses an exact substring match of quotedText + the candidate nearest the original position
// (true fuzzy/diff-based matching comes later).
import { lineColToOffset } from "./anchor";
import { buildLineMap } from "./linemap";
import type { CommentMetadata } from "./metadata";

export type AnchorStatus = "current" | "reanchored" | "outdated";

export interface Reanchored {
  startOffset: number;
  endOffset: number;
  status: AnchorStatus;
}

/** Index of the needle occurrence in haystack nearest to the hint offset (-1 if none). */
function nearestIndexOf(haystack: string, needle: string, hint: number): number {
  let best = -1;
  let bestDist = Infinity;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    const dist = Math.abs(i - hint);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
    from = i + 1;
  }
  return best;
}

/**
 * Resolve the anchor by diffing the createdAtSha source against the current one
 * and mapping the stored line range through it. Returns null when the mapping is
 * inconclusive (a boundary line was edited/removed, or the mapped span no longer
 * matches the quote) so the caller can fall back to quote search.
 *
 * A successful mapping is authoritative: it follows the document's actual edits
 * (disambiguating repeated quotes), so the resolved position is known-good and
 * reported as `current` even if the line number moved. "position shifted"
 * (`reanchored`) is reserved for the heuristic quote-search fallback, where the
 * match is only a best guess worth a second look.
 */
function reanchorByDiff(
  source: string,
  lineStarts: number[],
  meta: CommentMetadata,
  oldSource: string,
): Reanchored | null {
  const map = buildLineMap(oldSource, source);
  const newSl = map.get(meta.range.sl);
  const newEl = map.get(meta.range.el);
  // A boundary line was edited or removed → can't map cleanly; let the caller
  // fall back to quote search (the quote may still live on the changed line).
  if (newSl === undefined || newEl === undefined) return null;

  const startOffset = lineColToOffset(newSl, meta.range.sc, lineStarts);
  const endOffset = lineColToOffset(newEl, meta.range.ec, lineStarts);
  // Self-verify against the quote so an interior change can't slip through with a
  // stale span. An empty quote (rare) can't be verified, so trust the mapping.
  const quote = meta.quote ?? "";
  if (quote.length > 0 && source.slice(startOffset, endOffset) !== quote) return null;

  return { startOffset, endOffset, status: "current" };
}

/**
 * Resolve a comment's anchor against the current source.
 * @param source    The current (head) canonical source
 * @param lineStarts buildLineIndex(source)
 * @param meta      The comment's embedded metadata (quote / range / createdAtSha)
 * @param headSha   The current head SHA
 * @param oldSource The source as of the comment's createdAtSha, when available.
 *                  Enables diff-based re-anchoring; omit it to use quote search
 *                  only (the v1 fallback).
 */
export function reanchorComment(
  source: string,
  lineStarts: number[],
  meta: CommentMetadata,
  headSha: string,
  oldSource?: string,
): Reanchored {
  // createdAtSha matches the current head → the stored line/col is accurate
  if (meta.sha && meta.sha === headSha) {
    return {
      startOffset: lineColToOffset(meta.range.sl, meta.range.sc, lineStarts),
      endOffset: lineColToOffset(meta.range.el, meta.range.ec, lineStarts),
      status: "current",
    };
  }

  // Preferred: diff the exact createdAtSha source against the current one.
  if (oldSource !== undefined) {
    const byDiff = reanchorByDiff(source, lineStarts, meta, oldSource);
    if (byDiff) return byDiff;
  }

  const quote = meta.quote ?? "";
  if (quote.length === 0) return { startOffset: 0, endOffset: 0, status: "outdated" };

  // Fallback: using the original line as a hint, match the quote against the
  // current source and take the occurrence nearest the original position.
  const hint = lineColToOffset(meta.range.sl, meta.range.sc, lineStarts);
  const idx = nearestIndexOf(source, quote, hint);
  if (idx < 0) return { startOffset: 0, endOffset: 0, status: "outdated" };
  return { startOffset: idx, endOffset: idx + quote.length, status: "reanchored" };
}
