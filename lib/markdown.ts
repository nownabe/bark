// Source-position mapping — Design Doc §7.1 (アンカリングの核).
//
// remark/rehype がノードに持つ `position`(ソース上の line/col/offset)を、
// レンダリング後の DOM から辿れるよう `data-so` / `data-eo`(start/end offset)
// として要素に焼き込む rehype プラグイン。
//
// さらに **テキストノードを span でラップ**して各テキスト断片の開始 offset を
// 持たせることで、ブロック単位ではなく **文字単位**の選択 → ソース offset 変換を
// 可能にする(span 内のテキストはソースと 1:1 対応するため offset + 選択位置で解決)。

import { SKIP, visit } from 'unist-util-visit';
import type { Element, Root, Text } from 'hast';
import { defaultSchema } from 'rehype-sanitize';

/** 既にラップ済みの span を識別するマーカー属性。 */
const WRAP_MARKER = 'dataDrText';

export function rehypeSourcePos() {
  return (tree: Root) => {
    // 1. 位置を持つ要素に data-so / data-eo を付与
    visit(tree, 'element', (node: Element) => {
      const pos = node.position;
      if (pos?.start.offset != null && pos.end.offset != null) {
        node.properties ??= {};
        node.properties.dataSo = pos.start.offset;
        node.properties.dataEo = pos.end.offset;
      }
    });

    // 2. テキストノードを offset 付き span でラップ(文字単位精度)
    visit(tree, 'text', (node: Text, index, parent) => {
      if (index == null || parent == null || parent.type === 'root') return;
      const el = parent as Element;
      if (el.tagName === 'span' && el.properties?.[WRAP_MARKER] != null) return; // 二重ラップ防止
      const pos = node.position;
      if (pos?.start.offset == null || pos.end.offset == null) return;

      // 線形 = レンダリングテキスト長がソース範囲長と一致(区切り記号を含まない)。
      // inline code (`code`) のように position が区切り記号を含むトークンは非線形で、
      // 文字単位の `so + offset` 解決ができないため、選択時はトークン境界にクランプする。
      const linear = node.value.length === pos.end.offset - pos.start.offset;
      const span: Element = {
        type: 'element',
        tagName: 'span',
        properties: {
          [WRAP_MARKER]: '',
          dataSo: pos.start.offset,
          dataEo: pos.end.offset,
          ...(linear ? { dataDrLin: '1' } : {}),
        },
        children: [node],
      };
      el.children[index] = span;
      return [SKIP, index + 1]; // ラップした span の中(同じ text)を再訪しない
    });
  };
}

/**
 * rehype-sanitize 用スキーマ(§9)。実ソースは untrusted なので XSS 除去するが、
 * rehypeSourcePos が焼き込んだ data-so/data-eo 等と span は保持する必要がある。
 * **rehypeSourcePos の後**に sanitize を通す前提(position はその時点で不要)。
 */
export const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': [
      ...(defaultSchema.attributes?.['*'] ?? []),
      'dataSo',
      'dataEo',
      'dataDrText',
      'dataDrLin',
    ],
  },
};
