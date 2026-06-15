// Display submitted Suggestions over the document in Google Docs style (R3 display side).
// The target old text is shown with strikethrough, and the replacement text is shown
// in a green block right after it.
// Provided via StateField because it uses block decorations.
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

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
    const div = document.createElement('div');
    div.className = 'dr-sugg-new';
    div.textContent = this.text.length > 0 ? this.text : '(delete this range)';
    return div;
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
          decos.push(Decoration.mark({ class: 'dr-sugg-old' }).range(m.from, m.to));
          const lineEnd = tr.state.doc.lineAt(m.to).to;
          decos.push(
            Decoration.widget({ widget: new InsertWidget(m.replacement), block: true, side: 1 }).range(
              lineEnd,
            ),
          );
        }
        next = Decoration.set(decos, true);
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const suggestionViewTheme = EditorView.baseTheme({
  '.dr-sugg-old': {
    textDecoration: 'line-through',
    textDecorationColor: 'rgba(207,34,46,0.8)',
    color: '#86181d',
  },
  '.dr-sugg-new': {
    background: 'rgba(31,136,61,0.12)',
    borderLeft: '3px solid rgba(31,136,61,0.7)',
    padding: '2px 10px',
    margin: '2px 0',
    whiteSpace: 'pre-wrap',
    color: '#1a7f37',
  },
});
