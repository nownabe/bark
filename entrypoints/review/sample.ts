// Local sample document for offline verification of 難所#1.
// 後続スライスで GitHub から取得した .md ソースに差し替える。
export const sampleDoc = `# DocReview サンプル

これは **レンダリング → ソース位置マッピング** を検証するためのサンプルです。
任意のテキストをドラッグ選択すると、右パネルにソース上のアンカー
(offset / line:col / quotedText)が表示されます。

## 段落とインライン

文中の *強調* や \`inline code\`、[リンク](https://example.com) を
またいで選択しても、文字単位で範囲が解決できることを確認します。

## リスト

- 1つ目の項目
- 2つ目の項目（**太字**を含む）
- 3つ目の項目

## コードブロック

\`\`\`ts
function hello(name: string) {
  return \`Hello, \${name}!\`;
}
\`\`\`

最後の段落。ここまでがサンプルドキュメントです。
`;
