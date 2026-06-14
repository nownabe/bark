// Obsidian Live Preview-lite — CM6 の構文木から Markdown を装飾し、非アクティブ行の
// 区切り記号(##, **, ` 等)を隠す。Preview モードでもソースが正準のまま編集可能。
import { syntaxTree } from '@codemirror/language';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { Range } from '@codemirror/state';

const hide = Decoration.replace({});

function classFor(name: string): string | null {
  if (name.startsWith('ATXHeading') || name.startsWith('SetextHeading')) {
    const level = Number(name.slice(-1)) || 1;
    return `dr-h${Math.min(level, 6)}`;
  }
  if (name === 'StrongEmphasis') return 'dr-strong';
  if (name === 'Emphasis') return 'dr-em';
  if (name === 'InlineCode') return 'dr-code';
  return null;
}

// 非アクティブ行で隠す区切りノード(インライン中心。リスト/引用マークはレイアウト維持のため隠さない)。
const HIDDEN_MARKS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark']);

function buildDecorations(view: EditorView): DecorationSet {
  const decos: Array<Range<Decoration>> = [];
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const cls = classFor(node.name);
        if (cls && node.to > node.from) {
          decos.push(Decoration.mark({ class: cls }).range(node.from, node.to));
        }
        if (HIDDEN_MARKS.has(node.name) && node.to > node.from) {
          const line = view.state.doc.lineAt(node.from).number;
          if (line !== cursorLine) decos.push(hide.range(node.from, node.to));
        }
      },
    });
  }
  return Decoration.set(decos, true);
}

export const richMarkdown = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

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
});
