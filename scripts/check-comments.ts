// Verification for hard-problem #2/R6: normalize existing comments and restore anchors.
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
  // Tool-authored (with metadata)
  { id: 1, body: embedMetadata('ここ直して', meta), path: 'docs/spec.md', line: 3, user: { login: 'alice' } },
  // Foreign (no metadata) → degrade
  { id: 2, body: 'plain review comment', path: 'docs/spec.md', line: 5, user: { login: 'bob' } },
];
const issues: RawIssueComment[] = [
  { id: 3, body: 'just an issue comment', user: { login: 'carol' } },
];

const result = normalizeComments(reviews, issues);
check('normalized to 3 items', result.length === 3);

const tool = result.find((c) => c.id === 1)!;
check('tool-authored restores meta', JSON.stringify(tool.meta) === JSON.stringify(meta));
check('tool-authored visible body', tool.body === 'ここ直して');
check('tool-authored author', tool.author === 'alice');

const foreign = result.find((c) => c.id === 2)!;
check('foreign review has meta=null', foreign.meta === null);
check('foreign review degrades to path/line', foreign.path === 'docs/spec.md' && foreign.line === 5);

const issue = result.find((c) => c.id === 3)!;
check('issue has source=issue', issue.source === 'issue' && issue.meta === null);

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK: comments normalize; tool comments restore anchors; foreign degrade');
