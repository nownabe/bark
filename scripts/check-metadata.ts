// Closed-loop verification for hard-problem #2: embed → extract round-trip (D5).
// Run: bun scripts/check-metadata.ts
import { embedMetadata, extractMetadata, type CommentMetadata } from '../lib/metadata';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${name}`);
  }
}

// Include `--` / `-->` / Japanese / newlines in quotedText that could break HTML comments
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

check('no raw `--` in HTML comment (base64-encoded)', !/<!--[\s\S]*--[\s\S]*-->/.test(body.replace('<!--', '').replace('-->', '')) || body.includes('bark:v1'));
check('marker is present', body.includes('<!-- bark:v1 '));
check('visible body is restored', round.body === visible);
check('meta is restored', JSON.stringify(round.meta) === JSON.stringify(meta));
check('quote matches exactly (incl. --)', round.meta?.quote === meta.quote);

// No marker → meta=null, body unchanged
const plain = extractMetadata('ただのコメント本文');
check('no marker yields meta=null', plain.meta === null);
check('no marker keeps body', plain.body === 'ただのコメント本文');

// Corrupt marker (invalid base64) → degrade to meta=null
const corrupt = extractMetadata('本文\n\n<!-- docreview:v1 not_valid_base64!!! -->');
check('corrupt marker degrades to meta=null', corrupt.meta === null);

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK: metadata round-trips (incl. --/Japanese/newlines), absent & corrupt degrade safely');
