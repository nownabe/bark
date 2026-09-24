// Preview mode renders a GFM table as an HTML widget; inline Markdown inside
// its cells must render too, not show as raw `**`/`` ` ``/`[..](..)` source.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { richMarkdown, richMarkdownTheme } from "../entrypoints/review/richMarkdown";

// The leading paragraph keeps the default cursor (offset 0) outside the table.
function renderTable(table: string): HTMLTableElement {
  const view = new EditorView({
    state: EditorState.create({
      doc: `Intro\n\n${table}\n`,
      extensions: [markdown({ extensions: [GFM] }), richMarkdown, richMarkdownTheme],
    }),
    parent: document.body,
  });
  const el = view.dom.querySelector("table.dr-table");
  expect(el).not.toBeNull();
  return el as HTMLTableElement;
}

describe("preview mode: inline Markdown inside table cells", () => {
  test("emphasis, code, and strikethrough render without their markers", () => {
    const table = renderTable("| **bold** | *em* |\n|---|---|\n| `code` | ~~gone~~ |");
    const [bold, em] = table.querySelectorAll("th");
    const [code, strike] = table.querySelectorAll("td");
    expect(bold.querySelector(".dr-strong")?.textContent).toBe("bold");
    expect(em.querySelector(".dr-em")?.textContent).toBe("em");
    expect(code.querySelector(".dr-code")?.textContent).toBe("code");
    expect(strike.querySelector("s")?.textContent).toBe("gone");
    expect(table.textContent).not.toMatch(/[*`~]/);
  });

  test("a link renders as a safe anchor; unsafe schemes stay inert", () => {
    const table = renderTable("| a |\n|---|\n| see [ok](https://e.com) |\n| [bad](javascript:x) |");
    const [ok, bad] = table.querySelectorAll("a.dr-link");
    expect(ok.getAttribute("href")).toBe("https://e.com");
    expect(ok.textContent).toBe("ok");
    expect(ok.parentElement!.textContent).toBe("see ok");
    expect(bad.hasAttribute("href")).toBe(false);
  });

  test("an escaped pipe stays inside its cell", () => {
    const table = renderTable("| a \\| b | c |\n|---|---|");
    expect([...table.querySelectorAll("th")].map((c) => c.textContent)).toEqual(["a | b", "c"]);
  });
});

describe("preview mode: table inside a blockquote", () => {
  test("renders inside the quote without a stray empty quote line", () => {
    const table = renderTable("> note\n>\n> | a | b |\n> | --- | --- |\n> | 1 | 2 |");
    const block = table.parentElement!;
    expect(block.classList.contains("dr-table-block--quote")).toBe(true);
    expect([...table.querySelectorAll("th, td")].map((c) => c.textContent)).toEqual([
      "a",
      "b",
      "1",
      "2",
    ]);
    const quoteLines = [...block.parentElement!.querySelectorAll(".cm-line.dr-quote")];
    expect(quoteLines.map((l) => l.textContent)).toEqual(["note", ""]);
  });

  test("editing the table shows the `>` on every row, the header included", () => {
    const doc = "> | a |\n> | - |\n> | 1 |\n\nend";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.indexOf("1") },
        extensions: [markdown({ extensions: [GFM] }), richMarkdown, richMarkdownTheme],
      }),
      parent: document.body,
    });
    const rows = [...view.dom.querySelectorAll(".cm-line")].slice(0, 3);
    expect(rows.map((l) => l.textContent)).toEqual(["> | a |", "> | - |", "> | 1 |"]);
    view.destroy();
  });
});
