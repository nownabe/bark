// CodeMirror selection -> SourceAnchor conversion.
// The CM document is always the Markdown source itself, so the selection from/to
// map directly to source offsets, with no DOM reverse-lookup needed (the earlier
// react-markdown rendering required mapping rendered DOM back to source offsets).
import type { EditorState } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import type { SourceAnchor } from "../../lib/anchor";

/** Viewport coords (px) at which to anchor the selection bubble button. */
export interface BubblePos {
  top: number;
  left: number;
}

// Gap (px) between the selection's bottom-right corner and the bubble.
const BUBBLE_GAP = 6;

// CM update handler. Selecting text no longer opens the composer; it just tracks
// the pending selection (anchor, or null when the selection collapses). The
// bubble button's visibility/position is driven separately in App.tsx — it
// appears when the mouse is released, not while dragging.
export function handleSelectionUpdate(
  vu: ViewUpdate,
  setSelection: (a: SourceAnchor | null) => void,
): void {
  if (!vu.selectionSet) return;
  setSelection(cmSelectionToAnchor(vu.state));
}

// The point just below-right of a selection's end, where the bubble is anchored.
// Kept pure (no DOM) so it can be unit-tested. `coords` is a CodeMirror caret
// rect at the selection end; we drop the bubble below its bottom and a touch to
// the right.
export function bubbleAnchorPoint(
  coords: { bottom: number; left: number },
  opts: { gap?: number } = {},
): BubblePos {
  const gap = opts.gap ?? BUBBLE_GAP;
  return { top: coords.bottom + gap, left: coords.left + gap };
}

export function cmSelectionToAnchor(state: EditorState): SourceAnchor | null {
  const sel = state.selection.main;
  if (sel.empty) return null;
  const { from, to } = sel;
  const startLine = state.doc.lineAt(from);
  // A selection dragged through a line's newline ends on the NEXT line's first
  // offset. Reporting that line would span one the reviewer never selected, and
  // past the file's trailing newline it names a line GitHub does not have —
  // which 422s the whole review batch (issue #291). Close the range on the last
  // line the selection actually covers; `to - 1` is inside it because a
  // non-empty selection always has `to > from`.
  const endLine = state.doc.lineAt(to - 1);
  return {
    startOffset: from,
    endOffset: to,
    startLine: startLine.number,
    startCol: from - startLine.from + 1,
    endLine: endLine.number,
    endCol: Math.min(to, endLine.to) - endLine.from + 1,
    quotedText: state.doc.sliceString(from, to),
  };
}
