// Diff-related helpers for in/out-of-diff routing.
//
// GitHub review comments can only attach to lines inside a diff hunk on the
// RIGHT (new file) side. Parsing the unified-diff `patch` returned by
// `GET /pulls/{n}/files` gives us the commentable line ranges. The Planner
// uses this via the `isInDiff` callback in `PlannerContext` to route
// CreateComment ops to PostReviewBatch (in-diff) or PostIssueComment
// (out-of-diff).

import type { Comment } from "./types";

/** A file changed by the PR, as returned by `GET /pulls/{n}/files`. */
export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  /** Unified-diff patch. May be absent for very large or binary files. */
  patch?: string;
};

/** Commentable line range on the RIGHT (new file) side, inclusive. */
export type RightRange = {
  newStart: number;
  newEnd: number;
};

/** Parse a unified-diff patch into commentable RIGHT-side line ranges.
 *  Added (`+`) and context (` `) lines are commentable; deleted (`-`) lines
 *  do not advance the new-file line counter. */
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
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      newLine = m ? Number(m[1]) : 0;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      if (start === -1) start = newLine;
      end = newLine;
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // Deleted line: LEFT only. Do not advance newLine; do not flush.
    } else if (line.startsWith(" ")) {
      if (start === -1) start = newLine;
      end = newLine;
      newLine++;
    }
    // Ignore everything else (file headers, "\ No newline" markers, blank lines).
  }
  flush();
  return ranges;
}

/** True if a single line falls inside any RIGHT-side range. */
export function isLineInDiff(ranges: RightRange[], line: number): boolean {
  return ranges.some((r) => line >= r.newStart && line <= r.newEnd);
}

/** True if every line in `[startLine, endLine]` (inclusive) is in-diff. */
export function isRangeInDiff(ranges: RightRange[], startLine: number, endLine: number): boolean {
  for (let l = startLine; l <= endLine; l++) {
    if (!isLineInDiff(ranges, l)) return false;
  }
  return true;
}

/** Build a per-Comment `isInDiff` predicate from a list of changed files.
 *  The patches are parsed once eagerly; subsequent calls are O(number of
 *  ranges on the file). */
export function buildIsInDiff(changedFiles: ChangedFile[]): (comment: Comment) => boolean {
  const rangesByPath = new Map<string, RightRange[]>();
  for (const file of changedFiles) {
    rangesByPath.set(file.path, parseRightRanges(file.patch));
  }
  return (comment: Comment) => {
    const ranges = rangesByPath.get(comment.path);
    if (!ranges) return false;
    return isRangeInDiff(ranges, comment.anchor.range.sl, comment.anchor.range.el);
  };
}
