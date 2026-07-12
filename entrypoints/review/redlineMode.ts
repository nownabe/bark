// Baseline→head redline overlay for Preview mode (R10 / §7.10).
//
// A Google-Docs-style redline: how the rendered document changed from a
// *baseline* commit to the current *head*. redlineBaseField holds the baseline
// source; computeRedline(baseline, head) (lib/redline.ts) walks the char-level
// diff and returns offset-based segments in head coordinates, which we render as:
//   insertion (new since baseline) = green/underline mark (.dr-redline-ins)
//   deletion  (gone since baseline) = strikethrough widget (.dr-redline-del)
//
// This mirrors suggestMode.ts's decoration machinery, but diffs head-vs-baseline
// (a read-only overlay) instead of edited-buffer-vs-base, and uses its own
// classes so the two never collide when composed. The gating (preview only, no
// local edits, toggle on) is decided in App.tsx — this module just renders
// whatever baseline it is handed, and renders nothing when the baseline is empty
// or equal to head.
import { syntaxTree } from "@codemirror/language";
import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { computeRedline } from "../../lib/redline";
import { classFor } from "./richMarkdown";

export const setRedlineBase = StateEffect.define<string>();

export const redlineBaseField = StateField.define<string>({
  create() {
    return "";
  },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRedlineBase)) return e.value;
    return value;
  },
});

class RedlineDeletedWidget extends WidgetType {
  constructor(
    readonly text: string,
    // Extra classes for the inline context the text was deleted from (heading/
    // bold/italic/code), so the strikethrough keeps that styling instead of
    // collapsing to the default body size.
    readonly contextClass: string,
  ) {
    super();
  }
  eq(other: RedlineDeletedWidget) {
    return other.text === this.text && other.contextClass === this.contextClass;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.contextClass ? `dr-redline-del ${this.contextClass}` : "dr-redline-del";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

// Inline decoration classes (heading/bold/italic/code) that apply at `pos` in the
// current doc — the context the deleted text sat in. The deletion is gone from the
// doc, so look just to the left (side -1) of the position.
function contextClassesAt(state: EditorState, pos: number): string {
  const classes: string[] = [];
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    const cls = classFor(node.name);
    if (cls && !classes.includes(cls)) classes.push(cls);
    node = node.parent;
  }
  return classes.join(" ");
}

// simplify: changes inside richMarkdown replace-decorated blocks (tables,
// mermaid diagrams) are not surfaced — those blocks are swapped for widgets, so
// an inline mark/widget over the hidden source has no visible effect. Accepted
// v1 limitation (plan §5); upgrade path is to diff the rendered block content.
function build(view: EditorView): DecorationSet {
  const baseline = view.state.field(redlineBaseField);
  const head = view.state.doc.toString();
  if (!baseline || baseline === head) return Decoration.none;
  const decos = [];
  for (const seg of computeRedline(baseline, head)) {
    if (seg.op === "ins") {
      decos.push(Decoration.mark({ class: "dr-redline-ins" }).range(seg.from, seg.to));
    } else {
      // The deleted text is not in the doc, so show it as a strikethrough widget
      // at the head offset it was removed from, keeping its inline context style.
      const contextClass = contextClassesAt(view.state, seg.at);
      decos.push(
        Decoration.widget({
          widget: new RedlineDeletedWidget(seg.text, contextClass),
          side: -1,
        }).range(seg.at),
      );
    }
  }
  return Decoration.set(decos, true);
}

export const redlineDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.startState.field(redlineBaseField) !== u.state.field(redlineBaseField)
      ) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// Insertions echo suggest mode's green tint + underline (the "new" color);
// deletions are struck through in the danger red. Values match suggestTheme /
// the --red token so the two overlays read as one visual language.
export const redlineTheme = EditorView.baseTheme({
  ".dr-redline-ins": {
    backgroundColor: "rgba(31,136,61,0.15)",
    textDecoration: "underline",
    textDecorationColor: "rgba(31,136,61,0.6)",
  },
  ".dr-redline-del": {
    color: "var(--red, #cf222e)",
    textDecoration: "line-through",
    opacity: "0.8",
  },
});
