// Verification for R3: suggestion block formatting + kind metadata round-trip.
// Run: bun scripts/check-suggestion.ts
import { buildSuggestionBlock } from '../lib/github';
import { embedMetadata, extractMetadata, type CommentMetadata } from '../lib/metadata';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${name}`);
  }
}

const block = buildSuggestionBlock('const x = 2;');
check('suggestion fence の開始', block.startsWith('```suggestion\n'));
check('suggestion fence の終了', block.endsWith('\n```'));
check('置換テキストを含む', block.includes('const x = 2;'));

const meta: CommentMetadata = {
  cid: 'c1',
  path: 'docs/spec.md',
  range: { sl: 5, sc: 1, el: 5, ec: 10 },
  quote: 'const x = 1;',
  sha: 'abc1234',
  thread: 't1',
  kind: 'suggestion',
};
const body = embedMetadata(`提案です。\n\n${block}`, meta);
const round = extractMetadata(body);
check('kind が往復で復元', round.meta?.kind === 'suggestion');
check('suggestion ブロックが本文に残る', round.body.includes('```suggestion'));

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK: suggestion block formats correctly; kind round-trips');
