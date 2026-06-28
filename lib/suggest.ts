// Reviewer edit → suggestion conversion + diff for tracked changes (R3/§7.3, equivalent to Google Docs suggestions).
//  - charDiffs: char-level diff (for inline decoration: insert=underline / delete=strikethrough widget)
//  - diffToSuggestions: split into hunks via line-level LCS and convert to GitHub suggestions (line replacement)
import { diff_match_patch } from "diff-match-patch";
import { lineColToOffset } from "./anchor";
import type { CommentMetadata } from "./metadata";
import type { DisplayPosition } from "./pr/reanchor";

/** Extract the replacement text of a ```suggestion block from a comment body (null if absent).
 *
 * Accepts variable-length fences (≥3 backticks) so a suggestion whose content
 * contains an inner code fence — wrapped by `buildSuggestionBlock` with a
 * longer outer fence — round-trips intact. The closing fence is matched at
 * the same length via the backreference; trailing backticks (CommonMark
 * allows a longer close) are tolerated by `[^\`]` lookahead/end-of-string. */
export function extractSuggestionBlock(body: string): string | null {
  const m = body.match(/(`{3,})suggestion\n?([\s\S]*?)\n?\1(?!`)/);
  return m ? m[2] : null;
}

/**
 * Apply an accepted suggestion to the current source, returning the new text
 * (or null when the target text is no longer locatable).
 *
 * Suggestion anchors are stored line-based (sc=1, ec=1), so the
 * displayPosition's start and end collapse to a zero-width span for a
 * single-line replacement. Slicing with that range would *insert* the
 * replacement next to the original instead of overwriting it, producing
 * concatenated old+new text on commit. Size the replaced span from
 * `meta.quote.length` instead — the same approach `buildSuggestionMarks`
 * already uses for rendering.
 */
export function applyAcceptedSuggestion(args: {
  source: string;
  lineStarts: number[];
  meta: CommentMetadata;
  replacement: string;
  /** The reanchored position from the new layer's
   *  CommentView.displayPosition. `outdated` aborts the apply (the target
   *  text is no longer locatable). */
  displayPosition: DisplayPosition;
}): string | null {
  const { source, lineStarts, meta, replacement, displayPosition } = args;
  if (displayPosition.status === "outdated") return null;
  const from = lineColToOffset(displayPosition.range.sl, displayPosition.range.sc, lineStarts);
  const to = from + (meta.quote?.length ?? 0);
  return source.slice(0, from) + replacement + source.slice(to);
}

/** The visible text of a comment body with the suggestion block removed. */
export function stripSuggestionBlock(body: string): string {
  return body.replace(/(`{3,})suggestion\n?[\s\S]*?\n?\1(?!`)/g, "").trim();
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

/** A suggestion hunk's span in the *edited* (current) document, in char offsets. */
export interface SuggestionEditRange {
  /** Base line range (matches the corresponding SuggestionHunk.sl/el → its cid). */
  sl: number;
  el: number;
  /** The inserted (replacement) text's char range in the edited doc. For a pure
   * deletion (no replacement) this collapses to the point where the text was. */
  from: number;
  to: number;
}

/**
 * For each suggestion hunk (same grouping/order as {@link diffToSuggestions}),
 * the char range its replacement text occupies in the *edited* document. Lets a
 * click on the suggested text in the editor be mapped back to its hunk (the
 * hunks themselves carry only base-doc line numbers).
 */
export function suggestionEditRanges(base: string, edited: string): SuggestionEditRange[] {
  const baseLines = splitLines(base);
  const ops = lcsDiff(baseLines, splitLines(edited));
  const editedLines = splitLines(edited);
  const lineStart: number[] = [];
  let acc = 0;
  for (const ln of editedLines) {
    lineStart.push(acc);
    acc += ln.length + 1; // + the "\n" separator
  }
  const startOf = (line1: number) =>
    line1 - 1 < editedLines.length ? lineStart[line1 - 1] : edited.length;
  const endOf = (line1: number) =>
    line1 - 1 < editedLines.length
      ? lineStart[line1 - 1] + editedLines[line1 - 1].length
      : edited.length;

  const ranges: SuggestionEditRange[] = [];
  let baseLine = 1;
  let editedLine = 1; // 1-based index into editedLines
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === 0) {
      baseLine++;
      editedLine++;
      i++;
      continue;
    }
    const startBase = baseLine;
    const startEdited = editedLine;
    let del = 0;
    let ins = 0;
    while (i < ops.length && ops[i].op !== 0) {
      if (ops[i].op === -1) {
        del++;
        baseLine++;
      } else {
        ins++;
        editedLine++;
      }
      i++;
    }
    if (del > 0) {
      const from = startOf(startEdited);
      const to =
        ins > 0
          ? lineStart[startEdited + ins - 2] + editedLines[startEdited + ins - 2].length
          : from;
      ranges.push({ sl: startBase, el: startBase + del - 1, from, to });
    } else if (ins > 0) {
      // Pure insertion mirror of diffToSuggestions: the hunk absorbs an
      // adjacent base line so the edit range covers the inserted block plus
      // that anchor line in the edited doc.
      if (startBase - 1 < baseLines.length) {
        // Next base line exists; the anchor sits at editedLine `startEdited + ins`.
        ranges.push({
          sl: startBase,
          el: startBase,
          from: startOf(startEdited),
          to: endOf(startEdited + ins),
        });
      } else if (startBase >= 2) {
        // EOF insertion: the anchor is the previous edited line (at startEdited - 1).
        const anchorEdited = startEdited - 1;
        const lastInserted = startEdited + ins - 1;
        ranges.push({
          sl: startBase - 1,
          el: startBase - 1,
          from: startOf(anchorEdited),
          to: endOf(lastInserted),
        });
      }
    }
  }
  return ranges;
}

/**
 * Convert the base → edited diff into GitHub suggestion hunks that replace
 * lines. Pure line insertions (no deleted line) are absorbed into an adjacent
 * base line so the hunk has a target line for GitHub's line-replacement model:
 * prefer the NEXT base line (semantically "insert before this line"); fall
 * back to the PREVIOUS base line at EOF.
 */
export function diffToSuggestions(base: string, edited: string): SuggestionHunk[] {
  const baseLines = splitLines(base);
  const ops = lcsDiff(baseLines, splitLines(edited));
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
    } else if (ins.length > 0) {
      // Pure insertion — anchor to an adjacent base line so GitHub's line-
      // replacement suggestion model has a target. The outer loop will still
      // advance the anchor when it processes the next keep op (we don't
      // consume it here).
      if (startLine - 1 < baseLines.length) {
        // The next base line exists (insertion in middle or at start).
        const nextLine = baseLines[startLine - 1];
        hunks.push({
          sl: startLine,
          el: startLine,
          replacement: `${ins.join("\n")}\n${nextLine}`,
          quote: nextLine,
        });
      } else if (startLine >= 2) {
        // EOF insertion — anchor to the previous (last) base line.
        const prevLine = startLine - 1;
        const prevLineText = baseLines[prevLine - 1];
        hunks.push({
          sl: prevLine,
          el: prevLine,
          replacement: `${prevLineText}\n${ins.join("\n")}`,
          quote: prevLineText,
        });
      }
    }
  }
  return hunks;
}
