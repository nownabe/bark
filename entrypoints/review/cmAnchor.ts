// CodeMirror 選択 → SourceAnchor 変換(§7.1 のアンカリング, CM 版)。
// CM のドキュメントは常に Markdown ソースそのものなので、選択 from/to が直接
// ソース offset になる。react-markdown DOM 逆引き(旧 rehypeSourcePos/anchor.ts)は不要。
import type { EditorState } from '@codemirror/state';
import type { SourceAnchor } from '../../lib/anchor';

export function cmSelectionToAnchor(state: EditorState): SourceAnchor | null {
  const sel = state.selection.main;
  if (sel.empty) return null;
  const { from, to } = sel;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);
  return {
    startOffset: from,
    endOffset: to,
    startLine: startLine.number,
    startCol: from - startLine.from + 1,
    endLine: endLine.number,
    endCol: to - endLine.from + 1,
    quotedText: state.doc.sliceString(from, to),
  };
}
