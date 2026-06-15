// Highlight the anchor ranges of existing comments over the CM document (§R6, Google Docs style).
// A StateField + theme whose ranges are swapped via the setCommentHighlights effect.
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export interface HighlightRange {
  from: number;
  to: number;
  /** Whether this is an unsent draft (pending). Uses a different color. */
  pending?: boolean;
}

export const setCommentHighlights = StateEffect.define<HighlightRange[]>();

const commentMark = Decoration.mark({ class: "dr-comment-hl" });
const pendingMark = Decoration.mark({ class: "dr-pending-hl" });

export const commentHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setCommentHighlights)) {
        next = Decoration.set(
          effect.value
            .filter((r) => r.from < r.to)
            .map((r) => (r.pending ? pendingMark : commentMark).range(r.from, r.to)),
          true, // sort
        );
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const commentHighlightTheme = EditorView.baseTheme({
  ".dr-comment-hl": { backgroundColor: "rgba(255, 212, 0, 0.35)" },
  ".dr-pending-hl": { backgroundColor: "rgba(9, 105, 218, 0.22)" },
});
