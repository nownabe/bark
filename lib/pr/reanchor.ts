// Re-anchoring algorithm. Translates an immutable `Comment.anchor` to a
// current-source `DisplayPosition` for the editor / sidebar.
//
// Algorithm (per ADR 0004 §3):
//   1. If anchor.sha === currentHeadSha → status: current, range: anchor.range
//   2. If no FileContent at (anchor.sha, anchor.path) → status: outdated
//   3. Take the line map oldSource → currentSource (memoised by the caller via
//      `lineMapFor`; built here otherwise); if both anchor endpoints map →
//      status: mapped (quote matches) / shifted (quote differs)
//   4. An unmapped endpoint (single- or multi-line anchor) → bounded region
//      search (`locateLine`) over the diff region between the nearest mapped
//      neighbours, then columns carried through a char diff → mapped/shifted
//   5. Otherwise → status: outdated
//
// There is intentionally no whole-file fuzzy `quote` search (ADR 0004 §3): the
// region search is confined to where the old line's content must have gone,
// every choice must be unique, and a line whose quote no longer verifies is
// labelled `shifted` so the user is told to look.

import { diff_match_patch } from "diff-match-patch";
import { buildLineMap } from "./linemap";
import type { Anchor, Range } from "./types";

/** Most candidate lines the region search examines, centred on the expected
 *  position. Caps the cost of a large rewritten region. */
const REGION_CAP = 50;
/** Levenshtein-similarity floor for accepting a candidate line as "the same
 *  line, edited". Below it the paragraph counts as rewritten → outdated. */
const SIMILARITY_MIN = 0.5;

export type DisplayPosition =
  | { status: "current"; range: Range }
  | { status: "mapped"; range: Range }
  | { status: "shifted"; range: Range }
  | { status: "outdated" };

export function reanchor(
  anchor: Anchor,
  currentSource: string,
  currentHeadSha: string,
  oldSource: string | null,
  /** The `oldSource` → `currentSource` line map, when the caller already has it
   *  memoised (`lineMapFor`); built here otherwise. */
  memoisedLineMap?: Map<number, number>,
): DisplayPosition {
  if (anchor.sha === currentHeadSha) {
    return { status: "current", range: anchor.range };
  }
  if (oldSource === null) {
    return { status: "outdated" };
  }
  if (anchor.quote === "") {
    // Defensive: an anchor must carry quote at creation. Empty quote → outdated.
    return { status: "outdated" };
  }

  const lineMap = memoisedLineMap ?? buildLineMap(oldSource, currentSource);
  const newSl = lineMap.get(anchor.range.sl);
  const newEl = lineMap.get(anchor.range.el);
  if (newSl === undefined || newEl === undefined) {
    return reanchorByRegion(anchor, currentSource, oldSource, lineMap);
  }

  const newRange: Range = {
    sl: newSl,
    sc: anchor.range.sc,
    el: newEl,
    ec: anchor.range.ec,
  };

  if (extractTextAtRange(currentSource, newRange) === anchor.quote) {
    return { status: "mapped", range: newRange };
  }
  return { status: "shifted", range: newRange };
}

/** An anchor with an endpoint the line map did not resolve: locate each
 *  endpoint in its own diff region, then carry `sc`/`ec` across a char diff of
 *  the old line against the located one. */
function reanchorByRegion(
  anchor: Anchor,
  currentSource: string,
  oldSource: string,
  lineMap: Map<number, number>,
): DisplayPosition {
  const { sl, sc, el, ec } = anchor.range;
  const oldLines = oldSource.split("\n");
  const newLines = currentSource.split("\n");
  const span = locateSpan(oldLines, newLines, lineMap, anchor.range, anchor.quote);
  if (span === null) return { status: "outdated" };

  const dmp = new diff_match_patch();
  /** An old column in the coordinates of the line it ended up on. */
  const column = (oldLine: number, newLine: number, c: number) =>
    lineMap.get(oldLine) === newLine
      ? c
      : dmp.diff_xIndex(
          dmp.diff_main(oldLines[oldLine - 1] ?? "", newLines[newLine - 1] ?? ""),
          c - 1,
        ) + 1;

  if (sl !== el) {
    const range: Range = {
      sl: span.sl,
      sc: column(sl, span.sl, sc),
      el: span.el,
      ec: Math.min(column(el, span.el, ec), (newLines[span.el - 1] ?? "").length + 1),
    };
    return extractTextAtRange(currentSource, range) === anchor.quote
      ? { status: "mapped", range }
      : { status: "shifted", range };
  }

  const line = span.sl;
  const text = newLines[line - 1] ?? "";
  const diffs = dmp.diff_main(oldLines[sl - 1] ?? "", text);
  const sc2 = dmp.diff_xIndex(diffs, sc - 1) + 1;
  let ec2 = dmp.diff_xIndex(diffs, ec - 1) + 1;
  if (text.slice(sc2 - 1, ec2 - 1) === anchor.quote) {
    return { status: "mapped", range: { sl: line, sc: sc2, el: line, ec: ec2 } };
  }
  // The char diff lost the quote's edges (an edit touched them), but the quote
  // itself may still sit unambiguously in the line — prefer that over a span
  // the user would have to re-read.
  const at = text.indexOf(anchor.quote);
  if (at !== -1 && text.indexOf(anchor.quote, at + anchor.quote.length) === -1) {
    const range: Range = {
      sl: line,
      sc: at + 1,
      el: line,
      ec: at + anchor.quote.length + 1,
    };
    return { status: "mapped", range };
  }
  ec2 = Math.min(Math.max(ec2, sc2 + 1), text.length + 1);
  return { status: "shifted", range: { sl: line, sc: sc2, el: line, ec: ec2 } };
}

/**
 * The line span `range` now occupies in `newLines`: a mapped endpoint keeps its
 * mapping, an unmapped one goes through {@link locateLine} with the part of
 * `quote` that lies on that endpoint's line (exact under ADR 0002 §3's
 * definition of `quote`).
 *
 * Null when either endpoint is unlocatable, or when the located end does not
 * lie after the located start — endpoints that crossed or collapsed describe no
 * span the user would recognise, so the caller reports `outdated` (ADR 0004 §3).
 * A single-line range is the case `sl === el`, which resolves one endpoint.
 */
export function locateSpan(
  oldLines: string[],
  newLines: string[],
  lineMap: Map<number, number>,
  range: Range,
  quote: string,
): { sl: number; el: number } | null {
  const parts = quote.split("\n");
  const locate = (line: number, needle: string) =>
    lineMap.get(line) ?? locateLine(oldLines, newLines, lineMap, line, needle)?.line;

  const sl = locate(range.sl, parts[0] ?? "");
  if (sl === undefined) return null;
  if (range.sl === range.el) return { sl, el: sl };
  const el = locate(range.el, parts[parts.length - 1] ?? "");
  return el === undefined || el <= sl ? null : { sl, el };
}

/**
 * Find `oldLines[oldLine - 1]`'s current whereabouts in `newLines`, searching
 * only the region between its nearest line-mapped neighbours — the stretch the
 * old line's content must have gone to — capped at {@link REGION_CAP}
 * candidates around the expected position.
 *
 * A candidate wins only when it is unambiguous: the single line containing
 * `quote`, or the single best line by Levenshtein similarity to the old line
 * at or above {@link SIMILARITY_MIN}. Ties, duplicates and an empty region all
 * yield `null` — the caller reports `outdated` rather than guessing.
 */
export function locateLine(
  oldLines: string[],
  newLines: string[],
  lineMap: Map<number, number>,
  oldLine: number,
  quote: string,
): { line: number; text: string } | null {
  const oldText = oldLines[oldLine - 1] ?? "";
  if (oldText === "") return null;

  let prev: number | undefined;
  for (let k = oldLine - 1; k >= 1; k--) {
    if (lineMap.has(k)) {
      prev = k;
      break;
    }
  }
  let next: number | undefined;
  for (let k = oldLine + 1; k <= oldLines.length; k++) {
    if (lineMap.has(k)) {
      next = k;
      break;
    }
  }
  let lo = (prev === undefined ? 0 : (lineMap.get(prev) ?? 0)) + 1;
  let hi = (next === undefined ? newLines.length + 1 : (lineMap.get(next) ?? 0)) - 1;
  if (lo > hi) return null;

  const expected = Math.min(hi, Math.max(lo, lo + (oldLine - (prev ?? 0) - 1)));
  if (hi - lo + 1 > REGION_CAP) {
    lo = Math.max(lo, expected - Math.floor(REGION_CAP / 2));
    hi = Math.min(hi, lo + REGION_CAP - 1);
  }

  const candidates: Array<{ line: number; text: string }> = [];
  for (let j = lo; j <= hi; j++) candidates.push({ line: j, text: newLines[j - 1] ?? "" });

  const exact = candidates.filter((c) => c.text.includes(quote));
  if (exact.length === 1) return exact[0] ?? null;

  const dmp = new diff_match_patch();
  const scored = candidates
    .map((c) => ({
      candidate: c,
      score:
        c.text === ""
          ? 0
          : 1 -
            dmp.diff_levenshtein(dmp.diff_main(oldText, c.text)) /
              Math.max(oldText.length, c.text.length),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best === undefined || best.score < SIMILARITY_MIN) return null;
  if (scored[1]?.score === best.score) return null;
  return best.candidate;
}

/** The source text an anchor's `range` covers — the definition of
 *  `anchor.quote` (ADR 0002 §3). */
export function extractTextAtRange(source: string, range: Range): string {
  const lines = source.split("\n");
  const startLine = lines[range.sl - 1] ?? "";
  if (range.sl === range.el) {
    return startLine.slice(range.sc - 1, range.ec - 1);
  }
  const endLine = lines[range.el - 1] ?? "";
  const middle = lines.slice(range.sl, range.el - 1);
  return [startLine.slice(range.sc - 1), ...middle, endLine.slice(0, range.ec - 1)].join("\n");
}
