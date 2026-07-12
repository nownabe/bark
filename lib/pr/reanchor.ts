// Re-anchoring algorithm. Translates an immutable `Comment.anchor` to a
// current-source `DisplayPosition` for the editor / sidebar.
//
// Algorithm (per ADR 0004 §3):
//   1. If anchor.sha === currentHeadSha → status: current, range: anchor.range
//   2. If no FileContent at (anchor.sha, anchor.path) → status: outdated
//   3. Build LCS line map oldSource → currentSource; if both anchor endpoints
//      map → status: mapped (quote matches) / shifted (quote differs)
//   4. Otherwise → status: outdated
//
// There is intentionally no fuzzy `quote` fallback (ADR 0004 §3). A comment
// is either at a verified line or visibly `outdated`.

import { buildLineMap } from "./linemap";
import type { Anchor, Range } from "./types";

export type DisplayPosition =
  | { status: "current"; range: Range }
  | { status: "mapped"; range: Range }
  | { status: "shifted"; range: Range }
  | { status: "outdated" };

/** Outcome of mapping an anchor's region from `oldSource` to `newSource`:
 *   - `{ survives: true, range }`  — both endpoints map AND the quoted text is
 *     byte-identical, so the commented region is intact (just possibly moved).
 *   - `{ survives: false, range }` — endpoints map but the quote changed: the
 *     region's text was edited in place.
 *   - `{ survives: false, range: null }` — an endpoint no longer maps: the
 *     region was deleted / no longer exists.
 *  Callers requiring `oldSource` handle the "unavailable source" case
 *  themselves (there is nothing to map against). */
export type RegionMatch =
  | { survives: true; range: Range }
  | { survives: false; range: Range | null };

/** Does the anchored region still exist unchanged when `oldSource` becomes
 *  `newSource`? Shared by `reanchor` (mapped/shifted/outdated classification)
 *  and the R9 comment-status walk ("addressed" = first commit where the
 *  region stops surviving). Pure LCS line-map + quote check (ADR 0004 §3);
 *  no fuzzy fallback. An empty `anchor.quote` never survives.
 *
 *  `lineMap` may be supplied by callers that check many anchors against the
 *  same `(oldSource, newSource)` pair (the comment-status walk memoizes it by
 *  `(oldSha, newSha, path)`), avoiding a redundant O(n·m) LCS per anchor. */
export function regionSurvives(
  anchor: Anchor,
  oldSource: string,
  newSource: string,
  lineMap: Map<number, number> = buildLineMap(oldSource, newSource),
): RegionMatch {
  if (anchor.quote === "") {
    // Defensive: an anchor must carry quote at creation.
    return { survives: false, range: null };
  }
  const newSl = lineMap.get(anchor.range.sl);
  const newEl = lineMap.get(anchor.range.el);
  if (newSl === undefined || newEl === undefined) {
    return { survives: false, range: null };
  }

  const newRange: Range = {
    sl: newSl,
    sc: anchor.range.sc,
    el: newEl,
    ec: anchor.range.ec,
  };

  if (extractTextAtRange(newSource, newRange) === anchor.quote) {
    return { survives: true, range: newRange };
  }
  // Suggestion anchors are stored line-based (sc=1, ec=1) with quote = the
  // full lines sl..el. The char-based extraction above can never reproduce
  // such a quote (it collapses to zero width on a single line and drops the
  // end line on multi-line ranges), which left the quote check inert for
  // suggestions and misclassified byte-identical targets as "shifted"
  // (issue #176). Compare against the whole-line extraction too.
  if (
    newRange.sc === 1 &&
    newRange.ec === 1 &&
    extractLinesAtRange(newSource, newRange) === anchor.quote
  ) {
    return { survives: true, range: newRange };
  }
  return { survives: false, range: newRange };
}

export function reanchor(
  anchor: Anchor,
  currentSource: string,
  currentHeadSha: string,
  oldSource: string | null,
): DisplayPosition {
  if (anchor.sha === currentHeadSha) {
    return { status: "current", range: anchor.range };
  }
  if (oldSource === null) {
    return { status: "outdated" };
  }

  const match = regionSurvives(anchor, oldSource, currentSource);
  if (match.range === null) {
    return { status: "outdated" };
  }
  return match.survives
    ? { status: "mapped", range: match.range }
    : { status: "shifted", range: match.range };
}

function extractLinesAtRange(source: string, range: Range): string {
  return source
    .split("\n")
    .slice(range.sl - 1, range.el)
    .join("\n");
}

function extractTextAtRange(source: string, range: Range): string {
  const lines = source.split("\n");
  const startLine = lines[range.sl - 1] ?? "";
  if (range.sl === range.el) {
    return startLine.slice(range.sc - 1, range.ec - 1);
  }
  const endLine = lines[range.el - 1] ?? "";
  const middle = lines.slice(range.sl, range.el - 1);
  return [startLine.slice(range.sc - 1), ...middle, endLine.slice(0, range.ec - 1)].join("\n");
}
