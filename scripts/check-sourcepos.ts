// Offline check for hard-problem #1: confirm source positions survive remark→rehype and
// that the data-so/data-eo baked in by rehypeSourcePos + wrapper spans are correct,
// including quotedText alignment (source.slice(so,eo) === rendered text).
// Run: bun scripts/check-sourcepos.ts
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import { visit } from "unist-util-visit";
import type { Element, Root, Text } from "hast";
import { rehypeSourcePos, sanitizeSchema } from "../lib/markdown";

const md = `# Title

Hello **world**, \`code\`, and a [link](https://example.com).

- item one
- item two
`;

// Confirm data-so/span survive sanitize after rehypeSourcePos (§9).
const processor = unified()
  .use(remarkParse)
  .use(remarkRehype)
  .use(rehypeSourcePos)
  .use(rehypeSanitize, sanitizeSchema);
const tree = processor.runSync(processor.parse(md)) as Root;

let elementsWithSo = 0;
let linearSpans = 0;
let nonLinearSpans = 0;
let failures = 0;

visit(tree, "element", (node: Element) => {
  if (node.properties?.dataSo != null) elementsWithSo++;
  if (node.tagName === "span" && node.properties?.dataDrText != null) {
    const so = Number(node.properties.dataSo);
    const eo = Number(node.properties.dataEo);
    const text = (node.children[0] as Text)?.value ?? "";
    const slice = md.slice(so, eo);
    if (node.properties.dataDrLin === "1") {
      linearSpans++;
      // Linear: source.slice(so,eo) exactly matches the rendered text (precondition for char-level resolution)
      if (slice !== text) {
        failures++;
        console.error(
          `  linear mismatch @${so}-${eo}: source=${JSON.stringify(slice)} text=${JSON.stringify(text)}`,
        );
      }
    } else {
      nonLinearSpans++;
      // Non-linear: text is contained within the source range (safe due to boundary clamping)
      if (!slice.includes(text)) {
        failures++;
        console.error(
          `  non-linear token text not within range @${so}-${eo}: source=${JSON.stringify(slice)} text=${JSON.stringify(text)}`,
        );
      }
    }
  }
});

console.log({ elementsWithSo, linearSpans, nonLinearSpans, failures });
if (elementsWithSo === 0 || linearSpans === 0 || failures > 0) {
  console.error("FAIL: source-position mapping is broken");
  process.exit(1);
}
console.log("OK: positions propagate; linear tokens map 1:1; non-linear tokens clamp safely");
