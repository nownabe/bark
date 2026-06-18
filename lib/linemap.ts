// Line-level mapping between two revisions of a document — the deterministic
// core of diff-based re-anchoring (Design Doc §7.8). Given the source as of a
// comment's createdAtSha (old) and the current head source (new), map an old
// 1-based line number to its line in the new source.
//
// Lines are matched by a line-level LCS, so only lines that survive unchanged
// appear in the map; lines that were edited or removed are absent (their old
// number has no new home). Pure and side-effect free, hence fully reproducible
// and testable.

// Split into lines the same way buildLineIndex (lib/anchor) counts them: a
// trailing "\n" yields a final empty line, so line numbers line up with the
// offset math used to place anchors.
function splitLines(s: string): string[] {
  return s.split("\n");
}

/**
 * Map every unchanged line from `oldSource` to its line in `newSource`
 * (both 1-based). Changed/removed old lines are omitted from the result.
 */
export function buildLineMap(oldSource: string, newSource: string): Map<number, number> {
  const a = splitLines(oldSource);
  const b = splitLines(newSource);
  const n = a.length;
  const m = b.length;

  // LCS length table (dp[i][j] = LCS of a[i..] and b[j..]).
  const dp = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const map = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      map.set(i + 1, j + 1); // 1-based old line → 1-based new line
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++; // a[i] removed
    } else {
      j++; // b[j] inserted
    }
  }
  return map;
}
