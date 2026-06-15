// Reviewer edit → suggestion conversion + diff for tracked changes (R3/§7.3, equivalent to Google Docs suggestions).
//  - charDiffs: char-level diff (for inline decoration: insert=underline / delete=strikethrough widget)
//  - diffToSuggestions: split into hunks via line-level LCS and convert to GitHub suggestions (line replacement)
import { diff_match_patch } from "diff-match-patch";

/** Extract the replacement text of a ```suggestion block from a comment body (null if absent). */
export function extractSuggestionBlock(body: string): string | null {
  const m = body.match(/```suggestion\n?([\s\S]*?)```/);
  return m ? m[1].replace(/\n$/, "") : null;
}

/** The visible text of a comment body with the suggestion block removed. */
export function stripSuggestionBlock(body: string): string {
  return body.replace(/```suggestion\n?[\s\S]*?```/g, "").trim();
}

/** Char-level diff [op(-1 del / 0 eq / 1 ins), text]. For inline tracked-changes decoration. */
export function charDiffs(base: string, edited: string): Array<[number, string]> {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(base, edited);
  dmp.diff_cleanupSemantic(diffs);
  return diffs as Array<[number, string]>;
}

export interface SuggestionHunk {
  /** The base line range being replaced (1-based, inclusive). */
  sl: number;
  el: number;
  /** Replacement text (empty string = line deletion). */
  replacement: string;
  /** The original deleted text (for the anchor quote). */
  quote: string;
}

function splitLines(s: string): string[] {
  return s.endsWith("\n") ? s.slice(0, -1).split("\n") : s.split("\n");
}

type LineOp = { op: -1 | 0 | 1; text: string };

function lcsDiff(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 0, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: -1, text: a[i] });
      i++;
    } else {
      ops.push({ op: 1, text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ op: -1, text: a[i++] });
  while (j < m) ops.push({ op: 1, text: b[j++] });
  return ops;
}

/**
 * Convert the base → edited diff into GitHub suggestion hunks that replace lines.
 * v1 handles "delete or replace" hunks only (pure line insertions are excluded since there's no target line).
 */
export function diffToSuggestions(base: string, edited: string): SuggestionHunk[] {
  const ops = lcsDiff(splitLines(base), splitLines(edited));
  const hunks: SuggestionHunk[] = [];
  let baseLine = 1;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === 0) {
      baseLine++;
      i++;
      continue;
    }
    const startLine = baseLine;
    const del: string[] = [];
    const ins: string[] = [];
    while (i < ops.length && ops[i].op !== 0) {
      if (ops[i].op === -1) {
        del.push(ops[i].text);
        baseLine++;
      } else {
        ins.push(ops[i].text);
      }
      i++;
    }
    if (del.length > 0) {
      hunks.push({
        sl: startLine,
        el: startLine + del.length - 1,
        replacement: ins.join("\n"),
        quote: del.join("\n"),
      });
    }
    // Pure insertion (del.length===0) is unsupported in v1 since there's no target line
  }
  return hunks;
}
