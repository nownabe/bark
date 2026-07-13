// Rendering tests for the code-block language label in Preview view.
//
// In Preview mode (richMarkdown.ts) a fenced code block with a language info
// string (e.g. ```ts) shows a small, unobtrusive language label on the block —
// mirroring Obsidian Live Preview. The label is added as a line decoration on
// the opening fence line via a `data-lang` attribute and rendered with CSS.
// Blocks without an info string get no label, and ```mermaid blocks still
// render as diagrams (never a label).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { richMarkdown, richMarkdownTheme } from "../entrypoints/review/richMarkdown";

function render(doc: string, cursor = 0): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [markdown({ extensions: [GFM] }), richMarkdown, richMarkdownTheme],
    }),
    parent: document.body,
  });
}

// The opening-fence line carries the language label as a data-lang attribute.
const langLine = (view: EditorView) =>
  view.dom.querySelector<HTMLElement>(".dr-codeblock[data-lang]");

describe("preview mode: fenced code blocks show a language label", () => {
  // Cursor placed on the trailing empty line (offset 22), off the fence line,
  // so the label renders (it hides only while the fence line is being edited).
  test("a ```ts block labels its opening line with the language", () => {
    const view = render("```ts\nconst x = 1;\n```\n", 22);
    const line = langLine(view);
    expect(line).not.toBeNull();
    expect(line!.getAttribute("data-lang")).toBe("ts");
    view.destroy();
  });

  test("the language is normalized to lower case", () => {
    const view = render("```TypeScript\nconst x = 1;\n```\n", 24);
    expect(langLine(view)!.getAttribute("data-lang")).toBe("typescript");
    view.destroy();
  });

  test("a fenced block without an info string gets no label", () => {
    // Cursor off the fence line, so a label would show if one were (wrongly) added.
    const view = render("```\nplain\n```\n", 13);
    expect(langLine(view)).toBeNull();
    view.destroy();
  });

  test("a ```mermaid block is not labelled (it is special-cased as a diagram)", () => {
    // Cursor on the mermaid fence line: the diagram widget is not rendered
    // (source is shown for editing), which keeps the async mermaid loader out
    // of this unit test. The assertion is simply that no `data-lang` label is
    // attached — mermaid must never be treated as a plain labelled code block.
    const view = render("```mermaid\ngraph TD; A-->B;\n```\n", 2);
    expect(langLine(view)).toBeNull();
    view.destroy();
  });

  test("the label is not applied while the cursor is on the fence line (editing the info string)", () => {
    // Cursor at offset 2, on the opening ```ts fence line.
    const view = render("```ts\nconst x = 1;\n```\n", 2);
    expect(langLine(view)).toBeNull();
    view.destroy();
  });
});
