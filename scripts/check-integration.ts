// Live read-only integration test against PR #2 (uses GH_PAT).
// Run: direnv exec . bun scripts/check-integration.ts
// Read-only (does not pollute the PR). Write verification is done separately.
import { GitHubClient } from '../lib/github';
import { normalizeComments } from '../lib/comments';

const token = process.env.GH_PAT;
if (!token) {
  console.error('GH_PAT not set (run via: direnv exec . bun scripts/check-integration.ts)');
  process.exit(1);
}

const client = new GitHubClient(token);
const ref = { owner: 'nownabe', repo: 'mkprev', number: 2 };

const sha = await client.getPullHeadSha(ref);
console.log('head sha :', sha.slice(0, 7));

const files = await client.listMarkdownFiles(ref);
console.log('md files :', files.map((f) => `${f.path} (${f.status}, patch:${f.patch ? 'yes' : 'no'})`).join(', '));
if (files.length === 0) {
  console.error('FAIL: expected at least one changed .md');
  process.exit(1);
}

const content = await client.getFileContent(ref, files[0].path, sha);
console.log('content  :', content.length, 'chars; first line:', JSON.stringify(content.split('\n')[0]));

const [reviews, issues] = await Promise.all([
  client.listReviewComments(ref),
  client.listIssueComments(ref),
]);
const norm = normalizeComments(reviews, issues);
console.log('comments :', norm.length);
for (const c of norm) {
  console.log(`  - ${c.source}#${c.id} @${c.author} anchored:${!!c.meta}${c.meta ? ` ${c.meta.path} L${c.meta.range.sl}` : ''}`);
}

console.log('OK: live read pipeline (PR meta, files, content, comments) works');
