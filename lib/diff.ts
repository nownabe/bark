// In/out-of-diff routing — Design Doc §7.1 / decision D4.
//
// GitHub review comments can only attach to lines inside a diff hunk. Parse the
// unified-diff patch returned by pulls/{n}/files to find the commentable line ranges
// on the RIGHT (new file) side. If the whole selection is in-diff → review comment;
// otherwise → regular PR comment (quote + permalink).

/** Commentable line range on the RIGHT (new file) side (inclusive). */
export interface RightRange {
  newStart: number;
  newEnd: number;
}

/**
 * Convert a unified-diff patch into an array of commentable new-file line ranges on the RIGHT side.
 * Added lines (+) and context lines (starting with a space) appear on the RIGHT within a hunk and are commentable.
 * Deleted lines (-) are LEFT-only and do not advance the new-file line number.
 */
export function parseRightRanges(patch: string | undefined): RightRange[] {
  if (!patch) return [];
  const ranges: RightRange[] = [];
  let newLine = 0;
  let start = -1;
  let end = -1;
  const flush = () => {
    if (start !== -1) {
      ranges.push({ newStart: start, newEnd: end });
      start = -1;
      end = -1;
    }
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      flush();
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLine = m ? Number(m[1]) : 0;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      if (start === -1) start = newLine;
      end = newLine;
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // Deleted line: LEFT only. Don't advance newLine, and keep RIGHT-side continuity (no flush).
    } else if (line.startsWith(" ")) {
      if (start === -1) start = newLine;
      end = newLine;
      newLine++;
    }
    // Ignore everything else (\ No newline, file headers, empty string)
  }
  flush();
  return ranges;
}

/** Whether a line is in the RIGHT-side diff. */
export function isLineInDiff(ranges: RightRange[], line: number): boolean {
  return ranges.some((r) => line >= r.newStart && line <= r.newEnd);
}

/** True if every line in [startLine, endLine] is in-diff (= eligible for a review comment). */
export function isRangeInDiff(ranges: RightRange[], startLine: number, endLine: number): boolean {
  for (let l = startLine; l <= endLine; l++) {
    if (!isLineInDiff(ranges, l)) return false;
  }
  return true;
}
