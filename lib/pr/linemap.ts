// LCS-based line correspondence map between two text revisions.
//
// Given an `oldSource` and a `newSource`, returns a Map<oldLine, newLine>
// (1-based, inclusive) for lines that appear unchanged in both revisions.
// Lines that were deleted, inserted, or modified are not in the map.
//
// Used by `reanchor` to translate an old anchor's line endpoints to their
// current positions. See docs/adr/0004-reanchoring.md.

export function buildLineMap(oldSource: string, newSource: string): Map<number, number> {
  const oldLines = oldSource.split("\n");
  const newLines = newSource.split("\n");

  const n = oldLines.length;
  const m = newLines.length;

  // dp[i][j] = length of LCS for oldLines[0..i] vs newLines[0..j]
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from<number>({ length: m + 1 }).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  const map = new Map<number, number>();
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      map.set(i, j);
      i--;
      j--;
    } else if ((dp[i - 1]?.[j] ?? 0) >= (dp[i]?.[j - 1] ?? 0)) {
      i--;
    } else {
      j--;
    }
  }
  return map;
}
