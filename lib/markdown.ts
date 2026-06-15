// Source-position mapping — Design Doc §7.1 (the core of anchoring).
//
// A rehype plugin that bakes the `position` (source line/col/offset) carried by
// remark/rehype nodes into elements as `data-so` / `data-eo` (start/end offset),
// so it can be traced back from the rendered DOM.
//
// It also **wraps text nodes in spans** that carry each text fragment's start offset,
// enabling **char-level** (not just block-level) selection → source offset conversion
// (text inside a span maps 1:1 to the source, so it resolves via offset + selection position).

import { SKIP, visit } from 'unist-util-visit';
import type { Element, Root, Text } from 'hast';
import { defaultSchema } from 'rehype-sanitize';

/** Marker attribute that identifies an already-wrapped span. */
const WRAP_MARKER = 'dataDrText';

export function rehypeSourcePos() {
  return (tree: Root) => {
    // 1. Add data-so / data-eo to elements that have a position
    visit(tree, 'element', (node: Element) => {
      const pos = node.position;
      if (pos?.start.offset != null && pos.end.offset != null) {
        node.properties ??= {};
        node.properties.dataSo = pos.start.offset;
        node.properties.dataEo = pos.end.offset;
      }
    });

    // 2. Wrap text nodes in offset-bearing spans (char-level precision)
    visit(tree, 'text', (node: Text, index, parent) => {
      if (index == null || parent == null || parent.type === 'root') return;
      const el = parent as Element;
      if (el.tagName === 'span' && el.properties?.[WRAP_MARKER] != null) return; // Prevent double wrapping
      const pos = node.position;
      if (pos?.start.offset == null || pos.end.offset == null) return;

      // linear = the rendered text length equals the source range length (no delimiters included).
      // Tokens whose position includes delimiters, like inline code (`code`), are non-linear and
      // cannot be resolved char-by-char via `so + offset`, so selections clamp to the token boundary.
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
      return [SKIP, index + 1]; // Don't revisit inside the wrapped span (the same text)
    });
  };
}

/**
 * Schema for rehype-sanitize (§9). The actual source is untrusted, so strip XSS, but
 * the data-so/data-eo etc. baked in by rehypeSourcePos and the spans must be preserved.
 * Assumes sanitize runs **after rehypeSourcePos** (position is no longer needed by then).
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
