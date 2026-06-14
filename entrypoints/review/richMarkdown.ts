// Obsidian Live Preview-lite — CM6 の構文木から Markdown を装飾。ソースは正準のまま編集可能。
//  - インライン: 見出し/太字/斜体/inline code を装飾、非アクティブ行の記号(##, **, `, >)を隠す
//  - ブロック: コードブロック/引用/リストを行デコレーションで装飾
//  - テーブル: カーソルが外にあるとき HTML テーブルウィジェットで描画(中に入ると元のソース編集)
//
// 注: テーブルは block デコレーションのため、ViewPlugin ではなく **StateField** で提供する必要がある
//     (CM6: "Block decorations may not be specified via plugins")。
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
    // クリックでテーブル内にカーソルを置き、ソース編集に切り替える
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
      // テーブル: カーソルが外なら HTML ウィジェットで置換、中ならソース表示
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
        return false; // 子(行/セル)は処理しない
      }

      // ブロック行デコレーション
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

      // インライン装飾
      const cls = classFor(node.name);
      if (cls && node.to > node.from) {
        decos.push(Decoration.mark({ class: cls }).range(node.from, node.to));
      }

      // 区切り記号を非アクティブ行で隠す
      const isInlineCodeMark = node.name === 'CodeMark' && node.node.parent?.name === 'InlineCode';
      const hideMark =
        node.name === 'HeaderMark' ||
        node.name === 'EmphasisMark' ||
        node.name === 'QuoteMark' ||
        isInlineCodeMark;
      if (hideMark && node.to > node.from) {
        const line = state.doc.lineAt(node.from).number;
        if (line !== cursorLine) decos.push(Decoration.replace({}).range(node.from, node.to));
      }
    },
  });
  return Decoration.set(decos, true);
}

// block デコレーション(テーブル)を含むため StateField で提供する。
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
