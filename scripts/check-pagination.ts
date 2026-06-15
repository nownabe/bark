// Verification for hardening: Link header next-page parsing.
// Run: bun scripts/check-pagination.ts
import { parseNextLink } from "../lib/github";

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${name}`);
  }
}

const withNext =
  '<https://api.github.com/repositories/1/pulls/2/files?per_page=100&page=2>; rel="next", ' +
  '<https://api.github.com/repositories/1/pulls/2/files?per_page=100&page=5>; rel="last"';
check(
  "extracts next",
  parseNextLink(withNext) ===
    "https://api.github.com/repositories/1/pulls/2/files?per_page=100&page=2",
);

const lastPage =
  '<https://api.github.com/repositories/1/pulls/2/files?per_page=100&page=1>; rel="prev", ' +
  '<https://api.github.com/repositories/1/pulls/2/files?per_page=100&page=1>; rel="first"';
check("no next (last page) is null", parseNextLink(lastPage) === null);
check("no header is null", parseNextLink(null) === null);
check("empty string is null", parseNextLink("") === null);

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("OK: Link header next-page parsing works");
