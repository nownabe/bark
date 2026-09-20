// Reproduce rendering of a submitted suggestion over the document.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { suggestionMarksField, setSuggestionMarks } from "../entrypoints/review/suggestionView";

const doc = "line one\nline two\nline three\n";

/** Class names of every widget decoration in the field, in document order. */
function widgetClasses(state: EditorState): string[] {
  const out: string[] = [];
  state.field(suggestionMarksField).between(0, state.doc.length, (_from, _to, deco) => {
    const widget = deco.spec.widget as { toDOM?: () => HTMLElement } | undefined;
    if (widget?.toDOM) out.push(widget.toDOM().className);
  });
  return out;
}

describe("suggestionMarksField", () => {
  test("a submitted suggestion produces decorations (old mark + new block)", () => {
    let state = EditorState.create({ doc, extensions: [suggestionMarksField] });
    const from = doc.indexOf("line two");
    const to = from + "line two".length;
    state = state.update({
      effects: setSuggestionMarks.of([{ from, to, replacement: "LINE TWO" }]),
    }).state;
    expect(state.field(suggestionMarksField).size).toBe(2);
  });

  test("a suggestion whose range ends at end-of-document still renders", () => {
    const d = "alpha\nbeta";
    let state = EditorState.create({ doc: d, extensions: [suggestionMarksField] });
    const from = d.indexOf("beta");
    const to = d.length; // end of doc, no trailing newline
    state = state.update({
      effects: setSuggestionMarks.of([{ from, to, replacement: "BETA" }]),
    }).state;
    expect(state.field(suggestionMarksField).size).toBe(2);
  });

  // Issue #312: a shifted mark is a merge preview, so it carries the same
  // "position shifted" badge the sidebar shows next to its replacement.
  test("a shifted suggestion adds the position-shifted badge", () => {
    let state = EditorState.create({ doc, extensions: [suggestionMarksField] });
    const from = doc.indexOf("line two");
    const to = from + "line two".length;
    state = state.update({
      effects: setSuggestionMarks.of([{ from, to, replacement: "LINE TWO", shifted: true }]),
    }).state;
    expect(widgetClasses(state)).toEqual(["dr-sugg-new", "badge badge--reanchored"]);
  });

  test("an unshifted suggestion carries no badge", () => {
    let state = EditorState.create({ doc, extensions: [suggestionMarksField] });
    const from = doc.indexOf("line two");
    const to = from + "line two".length;
    state = state.update({
      effects: setSuggestionMarks.of([{ from, to, replacement: "LINE TWO" }]),
    }).state;
    expect(widgetClasses(state)).toEqual(["dr-sugg-new"]);
  });
});
