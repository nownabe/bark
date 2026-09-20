// Reviewer edit → suggestion conversion + diff for tracked changes (equivalent to Google Docs suggestions).
//  - charDiffs: char-level diff (for inline decoration: insert=underline / delete=strikethrough widget)
//  - diffToSuggestions: split into hunks via line-level LCS and convert to GitHub suggestions (line replacement)
import { diff_match_patch } from "diff-match-patch";
import { lineColToOffset } from "./anchor";
import type { SuggestionEdit } from "./drafts";
import type { CommentMetadata } from "./metadata";
import { buildLineMap } from "./pr/linemap";
import { type DisplayPosition, locateLine } from "./pr/reanchor";

/** Extract the replacement text of a ```suggestion block from a comment body (null if absent).
 *
 * Accepts variable-length fences (≥3 backticks) so a suggestion whose content
 * contains an inner code fence — wrapped by `buildSuggestionBlock` with a
 * longer outer fence — round-trips intact. The closing fence is matched at
 * the same length via the backreference; trailing backticks (CommonMark
 * allows a longer close) are tolerated by `[^\`]` lookahead/end-of-string.
 *
 * `\r?\n` around the fence lines tolerates CRLF bodies (GitHub's API returns
 * comment bodies with `\r\n` endings) so the outer `\r` is trimmed off the
 * extracted replacement, matching the `\n`-normalised source. */
export function extractSuggestionBlock(body: string): string | null {
  const m = body.match(/(`{3,})suggestion\r?\n?([\s\S]*?)\r?\n?\1(?!`)/);
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
 *
 * The fast path applies the replaced span only when it is byte-identical to
 * `meta.quote` (ADR 0004's quote-match check): a "shifted" target — the
 * document changed under the suggestion — would otherwise be cut mid-line
 * and stage corrupted content into the commit (issue #176).
 *
 * `displayPosition` is expressed in head-SHA coordinates (`baseSource`),
 * but the accept applies to the author's locally edited `source`. When the
 * two differ — an earlier accept or manual edit changed the line count —
 * the head-space line number is translated to its edited-space position via
 * the LCS line map before applying; an unmapped line (deleted or modified
 * locally) fails the fast path (issue #177).
 *
 * When the fast path fails, a single-line (in prose: whole-paragraph) target
 * gets a second chance (issue #269): the line is re-located directly in
 * `source` from the anchor-sha revision via the bounded region search, and the
 * suggestion is applied as a line-local three-way merge. Every patch hunk must
 * apply, and nothing outside that one line is ever touched.
 */
export function applyAcceptedSuggestion(args: {
  source: string;
  /** The head-SHA file content that `displayPosition`'s coordinates refer
   *  to. Equal to `source` when the author has no local edits. */
  baseSource: string;
  /** Line index of `source` (NOT `baseSource`). */
  lineStarts: number[];
  meta: CommentMetadata;
  replacement: string;
  /** The reanchored position from the new layer's
   *  CommentView.displayPosition. `outdated` aborts the apply (the target
   *  text is no longer locatable). */
  displayPosition: DisplayPosition;
  /** The file content at (`meta.sha`, `meta.path`) — the revision `meta.quote`
   *  was taken from. `null` when it is not available, which disables the
   *  line-local merge and leaves only the exact-quote fast path. */
  anchorSource: string | null;
}): string | null {
  const { source, baseSource, lineStarts, meta, replacement, displayPosition, anchorSource } = args;
  if (displayPosition.status === "outdated") return null;
  const quote = meta.quote ?? "";

  const exact = applyExactQuote(
    source,
    baseSource,
    lineStarts,
    displayPosition,
    quote,
    replacement,
  );
  if (exact !== null) return exact;

  // simplify: Phase 1 of #269 merges single-line targets only. Multi-line
  // anchors need the region search run per endpoint first (tracked as the
  // issue's deferred list).
  const { sl, el } = meta.range;
  if (anchorSource === null || sl !== el) return null;
  const oldLines = anchorSource.split("\n");
  // Only a whole-line suggestion anchor can be merged line-locally; anything
  // else means the caller handed us a revision the quote did not come from.
  if (oldLines[sl - 1] !== quote) return null;
  const located = locateLine(
    oldLines,
    source.split("\n"),
    buildLineMap(anchorSource, source),
    sl,
    quote,
  );
  if (located === null) return null;
  const merged = mergeLine(quote, replacement, located.text);
  if (merged === null) return null;
  return replaceLine(source, located.line, merged, replacement === "");
}

/** The exact path: the target line's text must still be byte-identical to the
 *  quote. Null means "not applicable here", not "refused". */
function applyExactQuote(
  source: string,
  baseSource: string,
  lineStarts: number[],
  displayPosition: Exclude<DisplayPosition, { status: "outdated" }>,
  quote: string,
  replacement: string,
): string | null {
  let targetLine = displayPosition.range.sl;
  if (source !== baseSource) {
    const mapped = buildLineMap(baseSource, source).get(targetLine);
    if (mapped === undefined) return null;
    targetLine = mapped;
  }
  const from = lineColToOffset(targetLine, displayPosition.range.sc, lineStarts);
  let to = from + quote.length;
  if (source.slice(from, to) !== quote) return null;
  // Issue #191: a line-deletion suggestion (empty replacement) whose span
  // covers whole line(s) must also drop the deleted line's trailing newline —
  // otherwise a stray blank line remains, diverging from GitHub's Apply. Absorb
  // the following "\n" when present; at EOF with no trailing newline, absorb
  // the preceding "\n" instead so the line above doesn't gain a blank tail.
  if (replacement === "" && from < to) {
    if (source[to] === "\n") to += 1;
    else if (source[from - 1] === "\n") return source.slice(0, from - 1) + source.slice(to);
  }
  return source.slice(0, from) + replacement + source.slice(to);
}

/** Apply the quote → replacement delta to a line that has drifted from the
 *  quote. Null when any hunk fails: a partially applied suggestion would stage
 *  text neither the reviewer nor the author wrote. */
function mergeLine(quote: string, replacement: string, lineText: string): string | null {
  if (lineText === quote) return replacement;
  const dmp = new diff_match_patch();
  const [merged, results] = dmp.patch_apply(dmp.patch_make(quote, replacement), lineText);
  return results.every(Boolean) ? merged : null;
}

function replaceLine(source: string, line: number, text: string, deleteLine: boolean): string {
  const lines = source.split("\n");
  // Issue #191 parity: a deletion takes the line's newline with it.
  if (deleteLine && text === "") lines.splice(line - 1, 1);
  else lines[line - 1] = text;
  return lines.join("\n");
}

/** The visible text of a comment body with the suggestion block removed. */
export function stripSuggestionBlock(body: string): string {
  return body.replace(/(`{3,})suggestion\r?\n?[\s\S]*?\r?\n?\1(?!`)/g, "").trim();
}

/**
 * Whether `source` differs from `base` in a way that produces a real,
 * submittable change — the single dirty-check the persistence gate and the
 * per-file edit load path share.
 *
 * A difference that is ONLY the file's trailing newline (added or removed)
 * yields zero `diffToSuggestions` hunks, so it can never be submitted or shown
 * with a Discard button. Treating it as a pending edit stranded the reviewer in
 * an unsubmittable tracked-changes state (issue #194); we normalize that single
 * trailing "\n" away so it no longer registers as a change.
 */
export function isMeaningfulEdit(base: string, source: string): boolean {
  if (source === base) return false;
  const strip = (s: string) => (s.endsWith("\n") ? s.slice(0, -1) : s);
  return strip(source) !== strip(base);
}

/** Char-level diff [op(-1 del / 0 eq / 1 ins), text]. For inline tracked-changes decoration. */
export function charDiffs(base: string, edited: string): Array<[number, string]> {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(base, edited);
  dmp.diff_cleanupSemantic(diffs);
  return diffs as Array<[number, string]>;
}

/** Re-apply the author's edits (the base → edited delta) onto a new base —
 *  a 3-way rebase via diff-match-patch. `clean` is true when every patch
 *  hunk applied; a false result means the merged text is missing at least
 *  one of the author's hunks and must not silently replace their edit. */
export function rebaseEdit(
  base: string,
  edited: string,
  newBase: string,
): { source: string; clean: boolean } {
  const dmp = new diff_match_patch();
  const patches = dmp.patch_make(base, edited);
  const [source, results] = dmp.patch_apply(patches, newBase);
  return { source, clean: results.every(Boolean) };
}

export type LoadedEditRebase =
  | { status: "unchanged"; edit: SuggestionEdit }
  | { status: "rebased"; edit: SuggestionEdit }
  | { status: "conflict"; edit: SuggestionEdit };

/** Reconcile a persisted per-file edit with the freshly-fetched file content.
 *
 *  - The base is unchanged → keep the edit, just (re)stamp `baseSha`.
 *  - The file changed upstream and the author's edits re-apply cleanly →
 *    "rebased": the edit is rebuilt on the new base, preserving both the
 *    author's changes and the upstream ones (the recovery path for a #187
 *    commit conflict).
 *  - They don't re-apply cleanly → "conflict": the edit is returned
 *    UNCHANGED (still anchored to its old base/baseSha, so the commit
 *    pipeline keeps refusing it rather than silently dropping hunks); the
 *    caller surfaces guidance to discard & re-apply manually. */
export function rebaseLoadedEdit(
  edit: SuggestionEdit,
  freshText: string,
  headSha: string,
): LoadedEditRebase {
  if (edit.base === freshText) {
    return { status: "unchanged", edit: { ...edit, baseSha: headSha } };
  }
  const { source, clean } = rebaseEdit(edit.base, edit.source, freshText);
  if (!clean) return { status: "conflict", edit };
  return {
    status: "rebased",
    edit: { source, base: freshText, baseSha: headSha, comments: edit.comments },
  };
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
