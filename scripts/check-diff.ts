// Verification for hard-problem #3: unified-diff patch → RIGHT-side commentable ranges.
// Run: bun scripts/check-diff.ts
import { isLineInDiff, isRangeInDiff, parseRightRanges } from '../lib/diff';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${name}`);
  }
}

// 2 hunks: new file 1-4 (context + additions), a deletion in between, latter half 10-12
const patch = [
  '@@ -1,2 +1,4 @@',
  ' context line 1', // new line 1 (context)
  '+added line 2', //   new line 2 (added)
  '+added line 3', //   new line 3 (added)
  ' context line 4', // new line 4 (context)
  '@@ -20,3 +10,3 @@',
  ' ctx 10', //          new line 10
  '-removed left only', // LEFT only, newLine stays put
  '+added 11', //        new line 11
  ' ctx 12', //          new line 12
].join('\n');

const ranges = parseRightRanges(patch);
check('2 ranges are produced', ranges.length === 2);
check('range 1 = 1..4', ranges[0]?.newStart === 1 && ranges[0]?.newEnd === 4);
check('range 2 = 10..12', ranges[1]?.newStart === 10 && ranges[1]?.newEnd === 12);

check('L2 is inside diff', isLineInDiff(ranges, 2));
check('L4 is inside diff (context line)', isLineInDiff(ranges, 4));
check('L5 is outside diff', !isLineInDiff(ranges, 5));
check('L11 is inside diff (RIGHT stays contiguous across deletion)', isLineInDiff(ranges, 11));

check('range selection 2..4 is fully inside diff', isRangeInDiff(ranges, 2, 4));
check('range selection 4..6 includes outside-diff lines', !isRangeInDiff(ranges, 4, 6));

check('patch undefined → empty', parseRightRanges(undefined).length === 0);

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK: diff parsing classifies in/out lines correctly');
