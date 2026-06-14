// Offline check for 難所#1: confirm source positions survive remark→rehype and
// that rehypeSourcePos焼き込む data-so/data-eo + wrapper spans are correct,
// including quotedText alignment (source.slice(so,eo) === rendered text).
// Run: bun scripts/check-sourcepos.ts
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { visit } from 'unist-util-visit';
import type { Element, Root, Text } from 'hast';
import { rehypeSourcePos } from '../lib/markdown';

const md = `# Title

Hello **world**, \`code\`, and a [link](https://example.com).

- item one
- item two
`;

const processor = unified().use(remarkParse).use(remarkRehype).use(rehypeSourcePos);
const tree = processor.runSync(processor.parse(md)) as Root;

let elementsWithSo = 0;
let linearSpans = 0;
let nonLinearSpans = 0;
let failures = 0;

visit(tree, 'element', (node: Element) => {
  if (node.properties?.dataSo != null) elementsWithSo++;
  if (node.tagName === 'span' && node.properties?.dataDrText != null) {
    const so = Number(node.properties.dataSo);
    const eo = Number(node.properties.dataEo);
    const text = (node.children[0] as Text)?.value ?? '';
    const slice = md.slice(so, eo);
    if (node.properties.dataDrLin === '1') {
      linearSpans++;
      // 線形: source.slice(so,eo) はレンダリングテキストと完全一致(文字単位解決の前提)
      if (slice !== text) {
        failures++;
        console.error(`  linear mismatch @${so}-${eo}: source=${JSON.stringify(slice)} text=${JSON.stringify(text)}`);
      }
    } else {
      nonLinearSpans++;
      // 非線形: テキストは source 範囲に含まれる(境界クランプで安全)
      if (!slice.includes(text)) {
        failures++;
        console.error(`  non-linear token text not within range @${so}-${eo}: source=${JSON.stringify(slice)} text=${JSON.stringify(text)}`);
      }
    }
  }
});

console.log({ elementsWithSo, linearSpans, nonLinearSpans, failures });
if (elementsWithSo === 0 || linearSpans === 0 || failures > 0) {
  console.error('FAIL: source-position mapping is broken');
  process.exit(1);
}
console.log('OK: positions propagate; linear tokens map 1:1; non-linear tokens clamp safely');
