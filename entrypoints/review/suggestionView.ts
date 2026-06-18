// Display submitted Suggestions over the document in Google Docs style (R3 display side).
// Suggestions are rendered char-level (like the reviewer's own pending edits): only
// the characters that actually change are decorated — the removed run is struck
// through inline in the document, and the inserted run is shown as a small inline
// widget right after it. The unchanged rest of the line stays as normal document
// text, so we never restate the whole line.
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { charDiffs } from "../../lib/suggest";

export interface SuggestionMark {
  from: number;
  to: number;
  replacement: string;
}

export const setSuggestionMarks = StateEffect.define<SuggestionMark[]>();

class InsertWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: InsertWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "dr-sugg-new";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

export const suggestionMarksField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setSuggestionMarks)) {
        const docLen = tr.state.doc.length;
        const decos = [];
        for (const m of e.value) {
          if (m.from < 0 || m.to > docLen || m.from >= m.to) continue;
          // Diff the current (old) text against the replacement and decorate only
          // the differing runs. `from..to` holds the old text in the document.
          const oldText = tr.state.doc.sliceString(m.from, m.to);
          let pos = m.from;
          for (const [op, text] of charDiffs(oldText, m.replacement)) {
            if (op === 0) {
              pos += text.length; // unchanged: leave as normal document text
            } else if (op === -1) {
              decos.push(Decoration.mark({ class: "dr-sugg-old" }).range(pos, pos + text.length));
              pos += text.length;
            } else if (text.length > 0) {
              decos.push(Decoration.widget({ widget: new InsertWidget(text), side: 1 }).range(pos));
            }
          }
        }
        next = Decoration.set(decos, true);
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const suggestionViewTheme = EditorView.baseTheme({
  ".dr-sugg-old": {
    textDecoration: "line-through",
    textDecorationColor: "rgba(207,34,46,0.8)",
    color: "#86181d",
  },
  ".dr-sugg-new": {
    background: "rgba(31,136,61,0.15)",
    textDecoration: "underline",
    textDecorationColor: "rgba(31,136,61,0.6)",
    borderRadius: "3px",
    whiteSpace: "pre-wrap",
    color: "#1a7f37",
  },
});
