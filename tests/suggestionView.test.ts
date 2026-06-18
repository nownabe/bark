// Reproduce rendering of a submitted suggestion over the document.
import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { suggestionMarksField, setSuggestionMarks } from "../entrypoints/review/suggestionView";

const doc = "line one\nline two\nline three\n";

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
});
