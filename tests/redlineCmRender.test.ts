// Rendering tests for the R10 baseline redline overlay in Preview view.
//
// redlineDecorations diffs a *baseline* commit's text against the *head* text
// (via computeRedline) and lays the changes over the rendered body:
//   - insertions (text new since baseline) → `.dr-redline-ins` mark decorations
//   - deletions (text gone since baseline) → `.dr-redline-del` strikethrough
//     widgets, anchored at the head offset where the text was removed.
// The baseline is pushed in through the `setRedlineBase` effect; when it is
// empty or equal to head, nothing is decorated (no redline on first view or an
// unchanged file).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { richMarkdown, richMarkdownTheme } from "../entrypoints/review/richMarkdown";
import {
  redlineBaseField,
  redlineDecorations,
  redlineTheme,
  setRedlineBase,
} from "../entrypoints/review/redlineMode";

// Build a Preview-mode view whose document is the head text; `baseline` is the
// commit we compare against (pushed via setRedlineBase).
function render(head: string, baseline: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc: head,
      extensions: [
        markdown({ extensions: [GFM] }),
        richMarkdown,
        richMarkdownTheme,
        redlineBaseField,
        redlineDecorations,
        redlineTheme,
      ],
    }),
    parent: document.body,
  });
  view.dispatch({ effects: setRedlineBase.of(baseline) });
  return view;
}

describe("redline overlay decorations", () => {
  test("no baseline → nothing decorated", () => {
    const view = render("hello world", "");
    expect(view.dom.querySelector(".dr-redline-ins")).toBeNull();
    expect(view.dom.querySelector(".dr-redline-del")).toBeNull();
    view.destroy();
  });

  test("baseline equal to head → nothing decorated", () => {
    const view = render("hello world", "hello world");
    expect(view.dom.querySelector(".dr-redline-ins")).toBeNull();
    expect(view.dom.querySelector(".dr-redline-del")).toBeNull();
    view.destroy();
  });

  test("text new since baseline is marked as an insertion", () => {
    // "brave " was added since the baseline.
    const view = render("hello brave world", "hello world");
    const ins = view.dom.querySelector(".dr-redline-ins");
    expect(ins).not.toBeNull();
    expect(ins!.textContent).toContain("brave");
    expect(view.dom.querySelector(".dr-redline-del")).toBeNull();
    view.destroy();
  });

  test("text removed since baseline shows as a strikethrough deletion widget", () => {
    // "brave " existed in the baseline but is gone from head.
    const view = render("hello world", "hello brave world");
    const del = view.dom.querySelector(".dr-redline-del");
    expect(del).not.toBeNull();
    expect(del!.textContent).toContain("brave");
    expect(view.dom.querySelector(".dr-redline-ins")).toBeNull();
    view.destroy();
  });

  test("a deletion widget carries the removed text at the right head offset", () => {
    // Replacement: "cat" → "dog" yields a del ("cat") immediately followed by an
    // ins ("dog") at the same head offset.
    const view = render("a dog b", "a cat b");
    const del = view.dom.querySelector(".dr-redline-del");
    const ins = view.dom.querySelector(".dr-redline-ins");
    expect(del).not.toBeNull();
    expect(del!.textContent).toBe("cat");
    expect(ins).not.toBeNull();
    expect(ins!.textContent).toContain("dog");
    view.destroy();
  });

  test("clearing the baseline removes the decorations", () => {
    const view = render("hello brave world", "hello world");
    expect(view.dom.querySelector(".dr-redline-ins")).not.toBeNull();
    view.dispatch({ effects: setRedlineBase.of("") });
    expect(view.dom.querySelector(".dr-redline-ins")).toBeNull();
    view.destroy();
  });
});
