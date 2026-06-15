// Tracked-changes decorations for the reviewer's suggest mode (Google Docs style).
// baseTextField holds the original source, and the character-level diff against the
// current doc is shown as:
//   insertion = underline/green (.dr-ins), deletion = strikethrough widget (.dr-del)
// The source stays canonical and remains editable.
import { StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { charDiffs } from "../../lib/suggest";

export const setBaseText = StateEffect.define<string>();

export const baseTextField = StateField.define<string>({
  create() {
    return "";
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
    const span = document.createElement("span");
    span.className = "dr-del";
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
      if (text.length > 0)
        decos.push(Decoration.mark({ class: "dr-ins" }).range(pos, pos + text.length));
      pos += text.length;
    } else {
      // The deleted text is not in the doc, so show it as a strikethrough widget at the current position.
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
  ".dr-ins": {
    backgroundColor: "rgba(31,136,61,0.15)",
    textDecoration: "underline",
    textDecorationColor: "rgba(31,136,61,0.6)",
  },
  ".dr-del": {
    color: "var(--red, #cf222e)",
    textDecoration: "line-through",
    opacity: "0.8",
  },
});
