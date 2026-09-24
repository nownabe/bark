// Block-level reading layout in Preview view: heading lines and code-block fences.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { richMarkdown, richMarkdownTheme } from "../entrypoints/review/richMarkdown";

function render(doc: string, cursor = doc.length): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [markdown({ extensions: [GFM] }), richMarkdown, richMarkdownTheme],
    }),
    parent: document.body,
  });
}

const lines = (view: EditorView) => [...view.dom.querySelectorAll<HTMLElement>(".cm-line")];

describe("preview mode: heading lines", () => {
  test("each heading line carries its level so it can be spaced from the text around it", () => {
    const view = render("# Title\n\ntext\n\n## Section\n\nmore\n");
    expect(view.dom.querySelector(".dr-hline--1")?.textContent).toBe("Title");
    expect(view.dom.querySelector(".dr-hline--2")?.textContent).toBe("Section");
    view.destroy();
  });

  test("the heading line keeps its level while the cursor is on it (no layout jump)", () => {
    const view = render("## Section\n", 3);
    expect(view.dom.querySelector(".dr-hline--2")?.textContent).toBe("## Section");
    view.destroy();
  });
});

describe("preview mode: list markers", () => {
  test("bullet markers render as bullets; ordered markers keep their numbers", () => {
    const view = render("- one\n* two\n\n1. first\n\nend");
    const [one, two, , first] = lines(view);
    expect(one.textContent).toBe("• one");
    expect(two.textContent).toBe("• two");
    expect(first.textContent).toBe("1. first");
    view.destroy();
  });

  test("the marker under the cursor shows its source", () => {
    const view = render("- one\n- two", 1);
    const [one, two] = lines(view);
    expect(one.textContent).toBe("- one");
    expect(two.textContent).toBe("• two");
    view.destroy();
  });
});

describe("preview mode: code-block fences", () => {
  test("fence lines are hidden when the cursor is outside the block", () => {
    const view = render("```ts\nconst x = 1;\n```\n");
    const [open, code, close] = lines(view);
    expect(open.classList.contains("dr-codeblock--open")).toBe(true);
    expect(open.textContent).toBe("");
    expect(code.textContent).toBe("const x = 1;");
    expect(close.classList.contains("dr-codeblock--close")).toBe(true);
    expect(close.textContent).toBe("");
    view.destroy();
  });

  test("the fence under the cursor shows its source for editing", () => {
    const view = render("```ts\nconst x = 1;\n```\n", 2);
    const [open, , close] = lines(view);
    expect(open.textContent).toBe("```ts");
    expect(close.textContent).toBe("");
    view.destroy();
  });

  test("an unterminated block does not hide its last content line", () => {
    const view = render("```ts\nconst x = 1;", 0);
    expect(lines(view)[1].textContent).toBe("const x = 1;");
    expect(view.dom.querySelector(".dr-codeblock--close")).toBeNull();
    view.destroy();
  });
});
