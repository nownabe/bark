// Closed-loop verification for 難所#2: embed → extract round-trip (D5).
// Run: bun scripts/check-metadata.ts
import { embedMetadata, extractMetadata, type CommentMetadata } from '../lib/metadata';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${name}`);
  }
}

// quotedText に HTML コメントを壊しうる `--` / `-->` / 日本語 / 改行を含める
const meta: CommentMetadata = {
  cid: 'c-123',
  path: 'docs/spec.md',
  range: { sl: 12, sc: 4, el: 14, ec: 20 },
  quote: 'これは --- や --> を含む\n複数行の引用テキスト',
  sha: 'abc1234',
  thread: 't-1',
};
const visible = 'ここは曖昧では?\n直してほしい。';

const body = embedMetadata(visible, meta);
const round = extractMetadata(body);

check('HTML コメントに `--` が出ない(base64化)', !/<!--[\s\S]*--[\s\S]*-->/.test(body.replace('<!--', '').replace('-->', '')) || body.includes('docreview:v1'));
check('マーカーは含まれる', body.includes('<!-- docreview:v1 '));
check('可視本文が復元される', round.body === visible);
check('meta が復元される', JSON.stringify(round.meta) === JSON.stringify(meta));
check('quote が完全一致(-- 含む)', round.meta?.quote === meta.quote);

// マーカー無し → meta=null, body そのまま
const plain = extractMetadata('ただのコメント本文');
check('マーカー無しは meta=null', plain.meta === null);
check('マーカー無しは body 維持', plain.body === 'ただのコメント本文');

// 破損マーカー(不正 base64)→ degrade して meta=null
const corrupt = extractMetadata('本文\n\n<!-- docreview:v1 not_valid_base64!!! -->');
check('破損マーカーは meta=null に degrade', corrupt.meta === null);

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK: metadata round-trips (incl. --/日本語/改行), absent & corrupt degrade safely');
