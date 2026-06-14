// Verification for R7: re-anchoring across commits via quotedText.
// Run: bun scripts/check-reanchor.ts
import { buildLineIndex } from '../lib/anchor';
import { reanchorComment } from '../lib/reanchor';
import type { CommentMetadata } from '../lib/metadata';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${name}`);
  }
}

const original = 'line one\nthe quick brown fox\nline three\n';
const meta: CommentMetadata = {
  cid: 'c1',
  path: 'd.md',
  range: { sl: 2, sc: 5, el: 2, ec: 10 }, // "quick"
  quote: 'quick',
  sha: 'sha-original',
  thread: 't1',
};

// 1) head == createdAtSha → current(保存 line/col をそのまま使用)
{
  const ls = buildLineIndex(original);
  const r = reanchorComment(original, ls, meta, 'sha-original');
  check('同一 SHA は current', r.status === 'current');
  check('current の offset が "quick" を指す', original.slice(r.startOffset, r.endOffset) === 'quick');
}

// 2) 行が挿入されてズレた新ソース → quote で再アンカー
{
  const shifted = 'NEW HEADER\n\nline one\nthe quick brown fox\nline three\n';
  const ls = buildLineIndex(shifted);
  const r = reanchorComment(shifted, ls, meta, 'sha-new');
  check('別 SHA + quote 一致は reanchored', r.status === 'reanchored');
  check('reanchored が "quick" を正しく指す', shifted.slice(r.startOffset, r.endOffset) === 'quick');
}

// 3) quote が消えた新ソース → outdated
{
  const removed = 'line one\nthe slow green turtle\nline three\n';
  const ls = buildLineIndex(removed);
  const r = reanchorComment(removed, ls, meta, 'sha-new');
  check('quote 消失は outdated', r.status === 'outdated');
}

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK: reanchor keeps current, re-finds shifted quotes, flags missing as outdated');
