// CodeMirror selection -> SourceAnchor conversion (anchoring from §7.1, CM version).
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
  const endLine = state.doc.lineAt(to);
  return {
    startOffset: from,
    endOffset: to,
    startLine: startLine.number,
    startCol: from - startLine.from + 1,
    endLine: endLine.number,
    endCol: to - endLine.from + 1,
    quotedText: state.doc.sliceString(from, to),
  };
}
