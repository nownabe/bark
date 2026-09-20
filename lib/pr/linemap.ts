// Line-level diff and line correspondence map between two text revisions.
//
// `buildLineMap` returns a Map<oldLine, newLine> (1-based, inclusive) for lines
// that appear unchanged in both revisions — the kept lines of `lineDiff`. Lines
// that were deleted, inserted, or modified are not in the map.
//
// Used by `reanchor` to translate an old anchor's line endpoints to their
// current positions, and by lib/suggest.ts to turn the reviewer's edits into
// suggestion hunks. See docs/adr/0004-reanchoring.md.

import { diff_match_patch } from "diff-match-patch";

export type LineOp = { op: -1 | 0 | 1; text: string };

/** The one-code-unit-per-line encoding tops out here; past it no line is kept
 *  and every anchor on the file reports `outdated` (ADR 0004 §5). */
const MAX_DISTINCT_LINES = 0xffff;

/**
 * Line-level edit script from `oldLines` to `newLines`.
 *
 * Myers via diff-match-patch over an encoding that gives each distinct line one
 * UTF-16 code unit; `Diff_Timeout = 0` disables both the half-match heuristic
 * and the deadline, so the result is optimal and runs in linear space. Deletes
 * and inserts weigh the same, so the kept lines are an LCS — the same meaning
 * the previous DP table had, at O((N+M)·D) instead of O(N·M).
 *
 * The encoder is ours rather than `diff_linesToChars_` because that one munges
 * a trailing empty line away, which would break the `split("\n")` line
 * convention every caller relies on.
 */
export function lineDiff(oldLines: string[], newLines: string[]): LineOp[] {
  const ids = new Map<string, number>();
  const texts: string[] = [];
  const encode = (lines: string[]): string | null => {
    let out = "";
    for (const line of lines) {
      let id = ids.get(line);
      if (id === undefined) {
        // simplify: one code unit per line caps the pair at 65,535 distinct
        // lines. Beyond it we keep nothing rather than guess; the upgrade path
        // is two code units per line.
        if (texts.length >= MAX_DISTINCT_LINES) return null;
        texts.push(line);
        id = texts.length;
        ids.set(line, id);
      }
      out += String.fromCharCode(id);
    }
    return out;
  };

  const encodedOld = encode(oldLines);
  const encodedNew = encodedOld === null ? null : encode(newLines);
  if (encodedOld === null || encodedNew === null) {
    return [
      ...oldLines.map((text): LineOp => ({ op: -1, text })),
      ...newLines.map((text): LineOp => ({ op: 1, text })),
    ];
  }

  const dmp = new diff_match_patch();
  dmp.Diff_Timeout = 0;
  const ops: LineOp[] = [];
  for (const [op, chunk] of dmp.diff_main(encodedOld, encodedNew, false)) {
    // Indexed, not `for…of`: line ids cover the surrogate range, and a string
    // iterator would fuse two adjacent lines into one code point.
    for (let c = 0; c < chunk.length; c++) {
      ops.push({ op: op as -1 | 0 | 1, text: texts[chunk.charCodeAt(c) - 1] ?? "" });
    }
  }
  return ops;
}

export function buildLineMap(oldSource: string, newSource: string): Map<number, number> {
  const map = new Map<number, number>();
  let i = 1;
  let j = 1;
  for (const { op } of lineDiff(oldSource.split("\n"), newSource.split("\n"))) {
    if (op === 0) map.set(i++, j++);
    else if (op === -1) i++;
    else j++;
  }
  return map;
}

/** The same correspondence read the other way: new line → old line. */
export function invertLineMap(map: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [from, to] of map) out.set(to, from);
  return out;
}

type MemoEntry = { oldSource: string; newSource: string; map: Map<number, number> };

/** simplify: 64-entry LRU; beyond it maps are rebuilt on rotation. The upgrade
 *  path is keying on RemoteState.FileContent identity. */
const MEMO_CAPACITY = 64;
const memo = new Map<string, MemoEntry>();

/**
 * {@link buildLineMap} memoised per `(oldSha, newSha, path)` — the triple
 * ADR 0004 §3 names — so one map serves every comment on a file and every
 * derivation, instead of one table per comment per keystroke (issue #280).
 *
 * Every hit is validated against the two source texts, so a reused or fake sha
 * (tests, another PR's fileContents) never returns a stale map: the memo stays
 * a pure function of its inputs and AppState stays a derivation.
 */
export function lineMapFor(
  key: { oldSha: string; newSha: string; path: string },
  oldSource: string,
  newSource: string,
): Map<number, number> {
  const k = `${key.oldSha}\0${key.newSha}\0${key.path}`;
  const hit = memo.get(k);
  if (hit && hit.oldSource === oldSource && hit.newSource === newSource) {
    memo.delete(k);
    memo.set(k, hit);
    return hit.map;
  }
  const map = buildLineMap(oldSource, newSource);
  memo.delete(k);
  memo.set(k, { oldSource, newSource, map });
  if (memo.size > MEMO_CAPACITY) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  return map;
}
