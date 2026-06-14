// reviewer サジェストモードの tracked-changes 装飾(Google Docs 風)。
// baseTextField に元ソースを保持し、現在の doc との文字差分を:
//   追加 = 下線/緑(.dr-ins)、削除 = 取り消し線ウィジェット(.dr-del)
// として表示する。ソースは正準のまま編集可能。
import { StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { charDiffs } from '../../lib/suggest';

export const setBaseText = StateEffect.define<string>();

export const baseTextField = StateField.define<string>({
  create() {
    return '';
  },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBaseText)) return e.value;
    return value;
  },
});

class DeletedWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: DeletedWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'dr-del';
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

function build(view: EditorView): DecorationSet {
  const base = view.state.field(baseTextField);
  const doc = view.state.doc.toString();
  if (!base || base === doc) return Decoration.none;
  const diffs = charDiffs(base, doc);
  const decos = [];
  let pos = 0;
  for (const [op, text] of diffs) {
    if (op === 0) {
      pos += text.length;
    } else if (op === 1) {
      if (text.length > 0) decos.push(Decoration.mark({ class: 'dr-ins' }).range(pos, pos + text.length));
      pos += text.length;
    } else {
      // 削除テキストは doc に無いので、現在位置にウィジェットで取り消し線表示
      decos.push(Decoration.widget({ widget: new DeletedWidget(text), side: -1 }).range(pos));
    }
  }
  return Decoration.set(decos, true);
}

export const suggestDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.startState.field(baseTextField) !== u.state.field(baseTextField)) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export const suggestTheme = EditorView.baseTheme({
  '.dr-ins': {
    backgroundColor: 'rgba(31,136,61,0.15)',
    textDecoration: 'underline',
    textDecorationColor: 'rgba(31,136,61,0.6)',
  },
  '.dr-del': {
    color: 'var(--red, #cf222e)',
    textDecoration: 'line-through',
    opacity: '0.8',
  },
});
