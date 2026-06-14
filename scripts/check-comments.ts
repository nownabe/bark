// Verification for 難所#2/R6: normalize existing comments and restore anchors.
// Run: bun scripts/check-comments.ts
import { embedMetadata, type CommentMetadata } from '../lib/metadata';
import { normalizeComments } from '../lib/comments';
import type { RawIssueComment, RawReviewComment } from '../lib/github';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${name}`);
  }
}

const meta: CommentMetadata = {
  cid: 'c1',
  path: 'docs/spec.md',
  range: { sl: 3, sc: 1, el: 3, ec: 9 },
  quote: 'Hello --',
  sha: 'deadbee',
  thread: 't1',
};

const reviews: RawReviewComment[] = [
  // ツール製(メタデータ付き)
  { id: 1, body: embedMetadata('ここ直して', meta), path: 'docs/spec.md', line: 3, user: { login: 'alice' } },
  // 外来(メタデータ無し)→ degrade
  { id: 2, body: 'plain review comment', path: 'docs/spec.md', line: 5, user: { login: 'bob' } },
];
const issues: RawIssueComment[] = [
  { id: 3, body: 'just an issue comment', user: { login: 'carol' } },
];

const result = normalizeComments(reviews, issues);
check('3 件に正規化', result.length === 3);

const tool = result.find((c) => c.id === 1)!;
check('ツール製は meta 復元', JSON.stringify(tool.meta) === JSON.stringify(meta));
check('ツール製の可視本文', tool.body === 'ここ直して');
check('ツール製の author', tool.author === 'alice');

const foreign = result.find((c) => c.id === 2)!;
check('外来 review は meta=null', foreign.meta === null);
check('外来 review は path/line で degrade', foreign.path === 'docs/spec.md' && foreign.line === 5);

const issue = result.find((c) => c.id === 3)!;
check('issue は source=issue', issue.source === 'issue' && issue.meta === null);

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK: comments normalize; tool comments restore anchors; foreign degrade');
