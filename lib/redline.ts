// Baseline→head redline segments (R10 / §7.10), decoration-free.
// A pure transform over charDiffs(baseline, head): it walks the char-level diff
// and emits offset-based segments in HEAD coordinates so any surface (CodeMirror
// decorations, tests, a future renderer) can position them without importing an
// editor. This mirrors the offset arithmetic in
// entrypoints/review/suggestMode.ts's build(), but returns plain data instead of
// CodeMirror decorations — lib/ stays surface-agnostic.
import { charDiffs } from "./suggest";

export type RedlineSegment =
  | { op: "ins"; from: number; to: number } // inserted text, char offsets in the HEAD source
  | { op: "del"; at: number; text: string }; // deleted text, anchored at a HEAD offset

/**
 * Diff `baseline` → `head` and return the changes as offset-based segments in
 * head coordinates:
 *  - `ins`: a `[from, to)` span of head that is new since baseline.
 *  - `del`: text present in baseline but gone from head, anchored at the head
 *    offset where it was removed (a replacement yields a `del` immediately
 *    followed by an `ins` at the same offset).
 *
 * Identical inputs return `[]`. `diff_cleanupSemantic` (applied inside
 * charDiffs) coalesces the diff into word-ish chunks, satisfying R10's
 * char/word-level requirement.
 */
export function computeRedline(baseline: string, head: string): RedlineSegment[] {
  const segments: RedlineSegment[] = [];
  let pos = 0; // offset into the HEAD source
  for (const [op, text] of charDiffs(baseline, head)) {
    if (op === 0) {
      pos += text.length; // unchanged: present in both, advance head offset
    } else if (op === 1) {
      // Insertion: text exists in head at [pos, pos + len).
      if (text.length > 0) segments.push({ op: "ins", from: pos, to: pos + text.length });
      pos += text.length;
    } else {
      // Deletion: text is gone from head, so it occupies no span — anchor it at
      // the current head offset without advancing pos.
      segments.push({ op: "del", at: pos, text });
    }
  }
  return segments;
}
