// 既存コメントのアンカー範囲を CM 本文上にハイライト(§R6, Google Docs 風)。
// setCommentHighlights effect で範囲群を差し替える StateField + テーマ。
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

export const setCommentHighlights = StateEffect.define<Array<{ from: number; to: number }>>();

const commentMark = Decoration.mark({ class: 'dr-comment-hl' });

export const commentHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setCommentHighlights)) {
        next = Decoration.set(
          effect.value
            .filter((r) => r.from < r.to)
            .map((r) => commentMark.range(r.from, r.to)),
          true, // sort
        );
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const commentHighlightTheme = EditorView.baseTheme({
  '.dr-comment-hl': { backgroundColor: 'rgba(255, 212, 0, 0.35)' },
});
