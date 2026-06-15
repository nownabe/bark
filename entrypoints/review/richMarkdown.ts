// Obsidian Live Preview-lite — decorate Markdown from the CM6 syntax tree. The source stays canonical and remains editable.
//  - Inline: decorate headings/bold/italic/inline code, and hide the markers (##, **, `, >) on inactive lines
//  - Block: decorate code blocks/blockquotes/lists with line decorations
//  - Table: render as an HTML table widget when the cursor is outside (edit the original source when the cursor moves inside)
//
// Note: because tables use block decorations, they must be provided via a **StateField** rather than a ViewPlugin
//     (CM6: "Block decorations may not be specified via plugins").
import { syntaxTree } from '@codemirror/language';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { type EditorState, type Range, StateField } from '@codemirror/state';

function classFor(name: string): string | null {
  if (name.startsWith('ATXHeading') || name.startsWith('SetextHeading')) {
    return `dr-h${Math.min(Number(name.slice(-1)) || 1, 6)}`;
  }
  if (name === 'StrongEmphasis') return 'dr-strong';
  if (name === 'Emphasis') return 'dr-em';
  if (name === 'InlineCode') return 'dr-code';
  return null;
}

function lineClassFor(name: string): string | null {
  if (name === 'FencedCode' || name === 'CodeBlock') return 'dr-codeblock';
  if (name === 'Blockquote') return 'dr-quote';
  if (name === 'ListItem') return 'dr-list';
  return null;
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
    const lines = this.raw.split('\n').filter((l) => l.trim().length > 0);
    const parseRow = (line: string) =>
      line.replace(/^\s*\|?/, '').replace(/\|?\s*$/, '').split('|').map((c) => c.trim());
    const table = document.createElement('table');
    table.className = 'dr-table';
    if (lines.length > 0) {
      const hr = table.createTHead().insertRow();
      for (const cell of parseRow(lines[0])) {
        const th = document.createElement('th');
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
    table.addEventListener('mousedown', (e) => {
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

function buildDecorations(state: EditorState): DecorationSet {
  const decos: Array<Range<Decoration>> = [];
  const cursor = state.selection.main.head;
  const cursorLine = state.doc.lineAt(cursor).number;
  const seenLines = new Set<number>();

  syntaxTree(state).iterate({
    enter: (node) => {
      // Table: replace with an HTML widget when the cursor is outside, show source when inside.
      if (node.name === 'Table') {
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
      const isInlineCodeMark = node.name === 'CodeMark' && node.node.parent?.name === 'InlineCode';
      const hideMark =
        node.name === 'HeaderMark' ||
        node.name === 'EmphasisMark' ||
        node.name === 'QuoteMark' ||
        isInlineCodeMark;
      if (hideMark && node.to > node.from) {
        const line = state.doc.lineAt(node.from).number;
        if (line !== cursorLine) {
          // Also hide the space right after heading ## / quote > (so no leading space remains).
          let to = node.to;
          if (
            (node.name === 'HeaderMark' || node.name === 'QuoteMark') &&
            state.doc.sliceString(to, to + 1) === ' '
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
  '.dr-h1': { fontSize: '1.6em', fontWeight: 'bold' },
  '.dr-h2': { fontSize: '1.4em', fontWeight: 'bold' },
  '.dr-h3': { fontSize: '1.2em', fontWeight: 'bold' },
  '.dr-h4, .dr-h5, .dr-h6': { fontWeight: 'bold' },
  '.dr-strong': { fontWeight: 'bold' },
  '.dr-em': { fontStyle: 'italic' },
  '.dr-code': {
    fontFamily: 'monospace',
    backgroundColor: 'rgba(175,184,193,0.2)',
    borderRadius: '4px',
    padding: '0 3px',
  },
  '.dr-codeblock': {
    fontFamily: 'monospace',
    backgroundColor: 'rgba(175,184,193,0.15)',
  },
  '.dr-quote': {
    borderLeft: '3px solid #d0d7de',
    paddingLeft: '12px',
    color: '#57606a',
  },
  '.dr-list': { paddingLeft: '8px' },
  '.dr-table': {
    borderCollapse: 'collapse',
    margin: '8px 0',
    fontSize: '0.95em',
  },
  '.dr-table th, .dr-table td': {
    border: '1px solid #d0d7de',
    padding: '4px 10px',
    textAlign: 'left',
  },
  '.dr-table th': { backgroundColor: '#f6f8fa', fontWeight: 'bold' },
});
