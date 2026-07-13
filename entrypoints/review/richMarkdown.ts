// Obsidian Live Preview-lite — decorate Markdown from the CM6 syntax tree. The source stays canonical and remains editable.
//  - Inline: decorate headings/bold/italic/inline code, and hide the markers (##, **, `, >) on inactive lines
//  - Block: decorate code blocks/blockquotes/lists with line decorations
//  - Table: render as an HTML table widget when the cursor is outside (edit the original source when the cursor moves inside)
//
// Note: because tables use block decorations, they must be provided via a **StateField** rather than a ViewPlugin
//     (CM6: "Block decorations may not be specified via plugins").
import { syntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { type EditorState, type Range, StateField } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { isMermaidFence, renderMermaid } from "./mermaid";

// Map a syntax-node name to its inline decoration class (heading/bold/italic/code).
// Exported so suggest mode can style deleted-text widgets with the same context.
export function classFor(name: string): string | null {
  if (name.startsWith("ATXHeading") || name.startsWith("SetextHeading")) {
    return `dr-h${Math.min(Number(name.slice(-1)) || 1, 6)}`;
  }
  if (name === "StrongEmphasis") return "dr-strong";
  if (name === "Emphasis") return "dr-em";
  if (name === "InlineCode") return "dr-code";
  return null;
}

function lineClassFor(name: string): string | null {
  if (name === "FencedCode" || name === "CodeBlock") return "dr-codeblock";
  if (name === "Blockquote") return "dr-quote";
  if (name === "ListItem") return "dr-list";
  return null;
}

// PR Markdown is untrusted; without this allowlist a `javascript:`/`data:`
// destination would land verbatim in an anchor href (#86). Relative URLs are
// also rejected — they would resolve against the extension page, not GitHub.
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function safeHref(raw: string): string | null {
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(raw).protocol) ? raw : null;
  } catch {
    return null;
  }
}

class LinkWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly href: string,
  ) {
    super();
  }
  eq(other: LinkWidget) {
    return other.text === this.text && other.href === this.href;
  }
  toDOM() {
    const a = document.createElement("a");
    a.className = "dr-link";
    a.textContent = this.text;
    const href = safeHref(this.href);
    if (href === null) return a; // inert text for disallowed/invalid URLs
    a.href = href;
    a.rel = "noopener noreferrer";
    a.target = "_blank";
    // A reviewer clicking the link should follow it (open in a new tab), so let
    // the browser handle the click natively — don't hijack it for editing. To
    // edit the link's Markdown source, move the cursor into it (e.g. with the
    // arrow keys), which reveals the canonical `[text](url)` source.
    return a;
  }
  ignoreEvent() {
    return true; // let the native anchor handle clicks (follow the link)
  }
}

class TableWidget extends WidgetType {
  constructor(
    readonly raw: string,
    readonly from: number,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return other.raw === this.raw && other.from === this.from;
  }
  toDOM(view: EditorView) {
    const lines = this.raw.split("\n").filter((l) => l.trim().length > 0);
    const parseRow = (line: string) =>
      line
        .replace(/^\s*\|?/, "")
        .replace(/\|?\s*$/, "")
        .split("|")
        .map((c) => c.trim());
    const table = document.createElement("table");
    table.className = "dr-table";
    if (lines.length > 0) {
      const hr = table.createTHead().insertRow();
      for (const cell of parseRow(lines[0])) {
        const th = document.createElement("th");
        th.textContent = cell;
        hr.appendChild(th);
      }
    }
    const tbody = table.createTBody();
    for (const line of lines.slice(2)) {
      const row = tbody.insertRow();
      for (const cell of parseRow(line)) {
        row.insertCell().textContent = cell;
      }
    }
    // On click, place the cursor inside the table and switch to source editing.
    table.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from + 1 } });
      view.focus();
    });
    return table;
  }
  ignoreEvent() {
    return true;
  }
}

// A rendered ```mermaid diagram. Async render (mermaid is lazy-loaded); the DOM
// is reused while the code is unchanged (eq), so cursor moves don't re-render.
class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(other: MermaidWidget) {
    return other.code === this.code;
  }
  toDOM(view: EditorView) {
    const div = document.createElement("div");
    div.className = "dr-mermaid";
    div.textContent = "Rendering diagram…";
    void renderMermaid(div, this.code);
    // Click the rendered diagram to select its source block, which opens the
    // comment composer for it (the block reveals its source while selected).
    div.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(div);
      let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1);
      while (node && node.name !== "FencedCode") node = node.parent;
      view.dispatch({ selection: { anchor: node?.from ?? pos, head: node?.to ?? pos } });
      view.focus();
    });
    return div;
  }
  ignoreEvent() {
    return true;
  }
}

/** The code inside a fenced block (the CodeText child), excluding the fences. */
function fencedCodeBody(state: EditorState, node: SyntaxNode): string {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === "CodeText") return state.doc.sliceString(c.from, c.to);
  }
  return "";
}

/** The language info string of a fenced block (the CodeInfo child), lowercased,
 *  or "" when the fence has none. Read from the syntax tree, not re-parsed. */
function fencedCodeLang(state: EditorState, node: SyntaxNode): string {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === "CodeInfo") return state.doc.sliceString(c.from, c.to).trim().toLowerCase();
  }
  return "";
}

function buildDecorations(state: EditorState): DecorationSet {
  const decos: Array<Range<Decoration>> = [];
  const cursor = state.selection.main.head;
  const cursorLine = state.doc.lineAt(cursor).number;
  const seenLines = new Set<number>();

  syntaxTree(state).iterate({
    enter: (node) => {
      // Table: replace with an HTML widget when the cursor is outside, show source when inside.
      if (node.name === "Table") {
        const inside = cursor >= node.from && cursor <= node.to;
        if (!inside) {
          decos.push(
            Decoration.replace({
              widget: new TableWidget(state.doc.sliceString(node.from, node.to), node.from),
              block: true,
            }).range(node.from, node.to),
          );
        }
        return false; // do not process children (rows/cells)
      }

      // Link: render `[text](url)` as a clickable anchor when the cursor is
      // outside, show the canonical source when inside (for editing).
      if (node.name === "Link") {
        const inside = cursor >= node.from && cursor <= node.to;
        if (!inside) {
          // Children: LinkMark "[", <text>, LinkMark "]", LinkMark "(", URL, LinkMark ")".
          // The link text is between the opening "[" and closing "]" marks; the
          // href is the URL node (fall back to the text if there is no URL).
          let textTo = node.to;
          let href: string | null = null;
          for (let child = node.node.firstChild; child; child = child.nextSibling) {
            if (child.name === "LinkMark" && state.doc.sliceString(child.from, child.to) === "]") {
              textTo = child.from;
            }
            if (child.name === "URL") {
              href = state.doc.sliceString(child.from, child.to);
            }
          }
          const text = state.doc.sliceString(node.from + 1, textTo);
          decos.push(
            Decoration.replace({
              widget: new LinkWidget(text, href ?? text),
            }).range(node.from, node.to),
          );
        }
        return false; // do not process children (marks/URL)
      }

      // Mermaid: render the diagram in place of the ```mermaid block when the
      // cursor is outside it; show the source for editing when inside.
      if (node.name === "FencedCode" && isMermaidFence(state.doc.lineAt(node.from).text)) {
        const inside = cursor >= node.from && cursor <= node.to;
        if (!inside) {
          decos.push(
            Decoration.replace({
              widget: new MermaidWidget(fencedCodeBody(state, node.node)),
              block: true,
            }).range(node.from, node.to),
          );
          return false; // skip default code-block styling / children
        }
      }

      // Code block language label: tag the opening fence line with the
      // language (e.g. `ts`) so CSS can show a small Obsidian-style label in
      // its top-right corner. Hidden while the cursor is on that line (the info
      // string is then being edited), matching the marker-hiding convention.
      // Mermaid fences are handled above (they render as diagrams, not labels).
      if (node.name === "FencedCode") {
        const openLine = state.doc.lineAt(node.from);
        const lang = fencedCodeLang(state, node.node);
        if (lang && openLine.number !== cursorLine) {
          seenLines.add(openLine.number);
          decos.push(
            Decoration.line({
              class: "dr-codeblock dr-codeblock--labelled",
              attributes: { "data-lang": lang },
            }).range(openLine.from),
          );
        }
      }

      // Block line decorations
      const lineCls = lineClassFor(node.name);
      if (lineCls) {
        const startLine = state.doc.lineAt(node.from).number;
        const endLine = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
        for (let n = startLine; n <= endLine; n++) {
          if (seenLines.has(n)) continue;
          seenLines.add(n);
          decos.push(Decoration.line({ class: lineCls }).range(state.doc.line(n).from));
        }
      }

      // Inline decorations
      const cls = classFor(node.name);
      if (cls && node.to > node.from) {
        decos.push(Decoration.mark({ class: cls }).range(node.from, node.to));
      }

      // Hide delimiter markers on inactive lines
      const isInlineCodeMark = node.name === "CodeMark" && node.node.parent?.name === "InlineCode";
      const hideMark =
        node.name === "HeaderMark" ||
        node.name === "EmphasisMark" ||
        node.name === "QuoteMark" ||
        isInlineCodeMark;
      if (hideMark && node.to > node.from) {
        const line = state.doc.lineAt(node.from).number;
        if (line !== cursorLine) {
          // Also hide the space right after heading ## / quote > (so no leading space remains).
          let to = node.to;
          if (
            (node.name === "HeaderMark" || node.name === "QuoteMark") &&
            state.doc.sliceString(to, to + 1) === " "
          ) {
            to++;
          }
          decos.push(Decoration.replace({}).range(node.from, to));
        }
      }
    },
  });
  return Decoration.set(decos, true);
}

// Provided via StateField because it includes block decorations (tables).
export const richMarkdown = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(deco, tr) {
    if (tr.docChanged || tr.startState.selection.main.head !== tr.state.selection.main.head) {
      return buildDecorations(tr.state);
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const richMarkdownTheme = EditorView.baseTheme({
  ".dr-h1": { fontSize: "1.6em", fontWeight: "bold" },
  ".dr-h2": { fontSize: "1.4em", fontWeight: "bold" },
  ".dr-h3": { fontSize: "1.2em", fontWeight: "bold" },
  ".dr-h4, .dr-h5, .dr-h6": { fontWeight: "bold" },
  ".dr-strong": { fontWeight: "bold" },
  ".dr-em": { fontStyle: "italic" },
  ".dr-code": {
    fontFamily: "monospace",
    backgroundColor: "rgba(175,184,193,0.2)",
    borderRadius: "4px",
    padding: "0 3px",
  },
  ".dr-codeblock": {
    fontFamily: "monospace",
    backgroundColor: "rgba(175,184,193,0.15)",
  },
  // Language label on the opening fence line — small, muted, top-right, quiet
  // until the reader looks for it (Obsidian Live Preview style).
  ".dr-codeblock--labelled": { position: "relative" },
  ".dr-codeblock--labelled::after": {
    content: "attr(data-lang)",
    position: "absolute",
    top: "0",
    right: "6px",
    fontFamily: "var(--font-mono)",
    fontSize: "0.75em",
    lineHeight: "1.6",
    color: "var(--faint)",
    pointerEvents: "none",
    userSelect: "none",
  },
  ".dr-quote": {
    borderLeft: "3px solid #d0d7de",
    paddingLeft: "12px",
    color: "#57606a",
  },
  ".dr-list": { paddingLeft: "8px" },
  ".dr-link": {
    color: "#0969da",
    textDecoration: "underline",
    cursor: "pointer",
  },
  ".dr-table": {
    borderCollapse: "collapse",
    margin: "8px 0",
    fontSize: "0.95em",
  },
  ".dr-table th, .dr-table td": {
    border: "1px solid #d0d7de",
    padding: "4px 10px",
    textAlign: "left",
  },
  ".dr-table th": { backgroundColor: "#f6f8fa", fontWeight: "bold" },
  ".dr-mermaid": {
    display: "flex",
    justifyContent: "center",
    padding: "8px 0",
    cursor: "pointer",
  },
  ".dr-mermaid svg": { maxWidth: "100%", height: "auto" },
  ".dr-mermaid--error": {
    display: "block",
    color: "#cf222e",
    fontFamily: "monospace",
    fontSize: "0.9em",
    whiteSpace: "pre-wrap",
  },
});
