// Verification for 難所#3: unified-diff patch → RIGHT-side commentable ranges.
// Run: bun scripts/check-diff.ts
import { isLineInDiff, isRangeInDiff, parseRightRanges } from '../lib/diff';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${name}`);
  }
}

// 2 ハンク: 新ファイル 1-4(文脈+追加), 削除を挟む, 後半 10-12
const patch = [
  '@@ -1,2 +1,4 @@',
  ' context line 1', // new line 1 (context)
  '+added line 2', //   new line 2 (added)
  '+added line 3', //   new line 3 (added)
  ' context line 4', // new line 4 (context)
  '@@ -20,3 +10,3 @@',
  ' ctx 10', //          new line 10
  '-removed left only', // LEFT only, newLine 据え置き
  '+added 11', //        new line 11
  ' ctx 12', //          new line 12
].join('\n');

const ranges = parseRightRanges(patch);
check('2 範囲が得られる', ranges.length === 2);
check('範囲1 = 1..4', ranges[0]?.newStart === 1 && ranges[0]?.newEnd === 4);
check('範囲2 = 10..12', ranges[1]?.newStart === 10 && ranges[1]?.newEnd === 12);

check('L2 は diff 内', isLineInDiff(ranges, 2));
check('L4 は diff 内(文脈行)', isLineInDiff(ranges, 4));
check('L5 は diff 外', !isLineInDiff(ranges, 5));
check('L11 は diff 内(削除を跨いでも RIGHT 連続)', isLineInDiff(ranges, 11));

check('範囲選択 2..4 は全て diff 内', isRangeInDiff(ranges, 2, 4));
check('範囲選択 4..6 は diff 外を含む', !isRangeInDiff(ranges, 4, 6));

check('patch undefined → 空', parseRightRanges(undefined).length === 0);

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK: diff parsing classifies in/out lines correctly');
