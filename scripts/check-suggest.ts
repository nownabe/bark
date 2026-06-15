// Verification for reviewer suggesting (#23): diffToSuggestions line hunks.
// Run: bun scripts/check-suggest.ts
import { diffToSuggestions } from "../lib/suggest";

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${name}`);
  }
}

// 1) Single-line replacement
{
  const base = "line1\nline2\nline3\n";
  const edited = "line1\nLINE2 changed\nline3\n";
  const h = diffToSuggestions(base, edited);
  check("replace: 1 hunk", h.length === 1);
  check("replace: range L2", h[0]?.sl === 2 && h[0]?.el === 2);
  check("replace: replacement", h[0]?.replacement === "LINE2 changed");
  check("replace: quote", h[0]?.quote === "line2");
}

// 2) Line deletion (empty replacement)
{
  const base = "a\nb\nc\n";
  const edited = "a\nc\n";
  const h = diffToSuggestions(base, edited);
  check("delete: 1 hunk", h.length === 1);
  check("delete: range L2", h[0]?.sl === 2 && h[0]?.el === 2);
  check("delete: empty replacement", h[0]?.replacement === "");
  check("delete: quote=b", h[0]?.quote === "b");
}

// 3) Multi-line replacement
{
  const base = "h1\nx\ny\nz\nh2\n";
  const edited = "h1\nX\nY\nh2\n";
  const h = diffToSuggestions(base, edited);
  check("multi-line: 1 hunk", h.length === 1);
  check("multi-line: range L2-L4", h[0]?.sl === 2 && h[0]?.el === 4);
  check("multi-line: replacement=X\\nY", h[0]?.replacement === "X\nY");
}

// 4) No change
{
  const same = "a\nb\n";
  check("no change: 0 hunks", diffToSuggestions(same, same).length === 0);
}

if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("OK: diffToSuggestions produces replace/delete hunks correctly");
