// Verification for reviewer suggesting (#23): diffToSuggestions line hunks.
// Run: bun scripts/check-suggest.ts
import { diffToSuggestions } from '../lib/suggest';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${name}`);
  }
}

// 1) 1行置換
{
  const base = 'line1\nline2\nline3\n';
  const edited = 'line1\nLINE2 changed\nline3\n';
  const h = diffToSuggestions(base, edited);
  check('置換: 1 ハンク', h.length === 1);
  check('置換: 範囲 L2', h[0]?.sl === 2 && h[0]?.el === 2);
  check('置換: replacement', h[0]?.replacement === 'LINE2 changed');
  check('置換: quote', h[0]?.quote === 'line2');
}

// 2) 行削除(replacement 空)
{
  const base = 'a\nb\nc\n';
  const edited = 'a\nc\n';
  const h = diffToSuggestions(base, edited);
  check('削除: 1 ハンク', h.length === 1);
  check('削除: 範囲 L2', h[0]?.sl === 2 && h[0]?.el === 2);
  check('削除: replacement 空', h[0]?.replacement === '');
  check('削除: quote=b', h[0]?.quote === 'b');
}

// 3) 複数行置換
{
  const base = 'h1\nx\ny\nz\nh2\n';
  const edited = 'h1\nX\nY\nh2\n';
  const h = diffToSuggestions(base, edited);
  check('複数行: 1 ハンク', h.length === 1);
  check('複数行: 範囲 L2-L4', h[0]?.sl === 2 && h[0]?.el === 4);
  check('複数行: replacement=X\\nY', h[0]?.replacement === 'X\nY');
}

// 4) 変更なし
{
  const same = 'a\nb\n';
  check('無変更: ハンク 0', diffToSuggestions(same, same).length === 0);
}

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK: diffToSuggestions produces replace/delete hunks correctly');
