// CodeMirror selection -> SourceAnchor conversion (anchoring from §7.1, CM version).
// The CM document is always the Markdown source itself, so the selection from/to
// map directly to source offsets. react-markdown DOM reverse-lookup (the old
// rehypeSourcePos/anchor.ts) is not needed.
import type { EditorState } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import type { SourceAnchor } from "../../lib/anchor";

/** Viewport coords (px) at which to anchor the selection bubble button. */
export interface BubblePos {
  top: number;
  left: number;
}

export interface SelectionHandlers {
  /** The pending selection that drives the bubble button (null clears it). */
  setSelection: (a: SourceAnchor | null) => void;
  /** The bubble button's viewport position (null hides it). */
  setBubblePos: (p: BubblePos | null) => void;
}

// Gap (px) between the top of the selection and the bubble's anchor point.
const BUBBLE_GAP = 8;

// CM update handler. Selecting text no longer opens the composer; it sets a
// pending selection plus the bubble button position (just above the selection
// start). The composer only opens when the bubble is clicked (App.tsx). When
// the selection collapses, both are cleared.
export function handleSelectionUpdate(vu: ViewUpdate, h: SelectionHandlers): void {
  if (!vu.selectionSet) return;
  const anchor = cmSelectionToAnchor(vu.state);
  h.setSelection(anchor);
  if (!anchor) {
    h.setBubblePos(null);
    return;
  }
  const coords = vu.view?.coordsAtPos(anchor.startOffset);
  h.setBubblePos(coords ? bubbleAnchorPoint(coords) : null);
}

// The point just above a selection's top-left, where the bubble is anchored.
// Kept pure (no DOM) so it can be unit-tested; the button itself sits above
// this point via CSS (translateY(-100%)).
export function bubbleAnchorPoint(
  coords: { top: number; left: number },
  opts: { gap?: number } = {},
): BubblePos {
  return { top: coords.top - (opts.gap ?? BUBBLE_GAP), left: coords.left };
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
