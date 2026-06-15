// Re-anchoring — Design Doc §7.8 / R7.
//
// When head advances to a new commit, the line/col stored on a comment (as of createdAtSha)
// can drift from the current source. If createdAtSha matches the current head, use the stored
// values as-is; otherwise re-resolve by matching quotedText against the current source. If not
// found, it's outdated.
// v1 uses an exact substring match of quotedText + the candidate nearest the original position
// (true fuzzy/diff-based matching comes later).
import { lineColToOffset } from './anchor';
import type { CommentMetadata } from './metadata';

export type AnchorStatus = 'current' | 'reanchored' | 'outdated';

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
 * Resolve a comment's anchor against the current source.
 * @param source    The current (head) canonical source
 * @param lineStarts buildLineIndex(source)
 * @param meta      The comment's embedded metadata (quote / range / createdAtSha)
 * @param headSha   The current head SHA
 */
export function reanchorComment(
  source: string,
  lineStarts: number[],
  meta: CommentMetadata,
  headSha: string,
): Reanchored {
  // createdAtSha matches the current head → the stored line/col is accurate
  if (meta.sha && meta.sha === headSha) {
    return {
      startOffset: lineColToOffset(meta.range.sl, meta.range.sc, lineStarts),
      endOffset: lineColToOffset(meta.range.el, meta.range.ec, lineStarts),
      status: 'current',
    };
  }
  const quote = meta.quote ?? '';
  if (quote.length === 0) return { startOffset: 0, endOffset: 0, status: 'outdated' };

  // Using the original line as a hint, match the quote against the current source
  const hint = lineColToOffset(meta.range.sl, meta.range.sc, lineStarts);
  const idx = nearestIndexOf(source, quote, hint);
  if (idx < 0) return { startOffset: 0, endOffset: 0, status: 'outdated' };
  return { startOffset: idx, endOffset: idx + quote.length, status: 'reanchored' };
}
