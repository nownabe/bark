// Rendering tests for the reviewer's suggest mode in Preview view.
//
// In Preview mode the reviewer's tracked-changes deletions are shown as a
// strikethrough widget (`.dr-del`, suggestMode.ts) laid over the document, while
// richMarkdown.ts decorates the surrounding inline context (headings, bold,
// italic, inline code). The deleted text must keep the *same inline styling as
// the context it was removed from* — e.g. deleting part of a heading must keep
// the heading font size, deleting part of bold text must stay bold, etc.
//
// These tests render a real CodeMirror view in happy-dom and compare the deleted
// widget's computed style against the styled reference element on the same line.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { richMarkdown, richMarkdownTheme } from "../entrypoints/review/richMarkdown";
import {
  baseTextField,
  setBaseText,
  suggestDecorations,
  suggestTheme,
} from "../entrypoints/review/suggestMode";

// Build a Preview-mode reviewer view: `doc` is the reviewer's edited text and
// `base` is the original. The character diff renders removed text as `.dr-del`.
function render(doc: string, base: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ extensions: [GFM] }),
        richMarkdown,
        richMarkdownTheme,
        baseTextField,
        suggestDecorations,
        suggestTheme,
      ],
    }),
    parent: document.body,
  });
  view.dispatch({ effects: setBaseText.of(base) });
  return view;
}

function css(el: Element): CSSStyleDeclaration {
  return getComputedStyle(el as HTMLElement);
}

describe("suggest mode: deleted text keeps the surrounding inline style", () => {
  test("deleting the end of a heading keeps the heading font size", () => {
    const view = render("## Hello", "## Hello World");
    const heading = view.dom.querySelector(".dr-h2");
    const del = view.dom.querySelector(".dr-del");
    expect(heading).not.toBeNull();
    expect(del).not.toBeNull();
    // The struck-through " World" must render at the heading size, not the
    // default body size.
    expect(css(del!).fontSize).toBe(css(heading!).fontSize);
    view.destroy();
  });

  test("deleting inside a heading keeps the heading font size", () => {
    const view = render("## Helo", "## Hello");
    const heading = view.dom.querySelector(".dr-h2");
    const del = view.dom.querySelector(".dr-del");
    expect(heading).not.toBeNull();
    expect(del).not.toBeNull();
    expect(css(del!).fontSize).toBe(css(heading!).fontSize);
    view.destroy();
  });

  test("deleting bold text stays bold", () => {
    const view = render("**Hello**", "**Hello World**");
    const strong = view.dom.querySelector(".dr-strong");
    const del = view.dom.querySelector(".dr-del");
    expect(strong).not.toBeNull();
    expect(del).not.toBeNull();
    expect(css(del!).fontWeight).toBe(css(strong!).fontWeight);
    view.destroy();
  });

  test("deleting italic text stays italic", () => {
    const view = render("*Hello*", "*Hello World*");
    const em = view.dom.querySelector(".dr-em");
    const del = view.dom.querySelector(".dr-del");
    expect(em).not.toBeNull();
    expect(del).not.toBeNull();
    expect(css(del!).fontStyle).toBe("italic");
    view.destroy();
  });

  test("deleting inline code keeps the code background", () => {
    const view = render("`foo`", "`foo bar`");
    const code = view.dom.querySelector(".dr-code");
    const del = view.dom.querySelector(".dr-del");
    expect(code).not.toBeNull();
    expect(del).not.toBeNull();
    expect(css(del!).backgroundColor).toBe(css(code!).backgroundColor);
    view.destroy();
  });
});
