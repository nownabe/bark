// CodeMirror selection -> SourceAnchor conversion (anchoring from §7.1, CM version).
// The CM document is always the Markdown source itself, so the selection from/to
// map directly to source offsets. react-markdown DOM reverse-lookup (the old
// rehypeSourcePos/anchor.ts) is not needed.
import type { EditorState } from "@codemirror/state";
import type { SourceAnchor } from "../../lib/anchor";

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
