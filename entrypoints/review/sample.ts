// Local sample document for offline verification.
// Replaced by the .md source fetched from GitHub in normal use.
export const sampleDoc = `# Bark sample

This sample exists to verify **rendering and source-position mapping**.
Drag-select any text and the right panel shows the resolved anchor
(offset / line:col / quotedText).

## Paragraphs and inline elements

This text contains *emphasis*, \`inline code\`, and a
[link](https://example.com). Selecting across them should still resolve a
character-precise range.

In particular, inline code (\`const x = 1\`) is a token with delimiters and
clamps to the token boundary rather than mapping per character.

## Lists

- First item
- Second item (with **bold**)
- Third item (with \`code\`)

## Code block

\`\`\`ts
function hello(name: string) {
  return \`Hello, \${name}!\`;
}
\`\`\`

The final paragraph. This is the end of the sample document.
`;
