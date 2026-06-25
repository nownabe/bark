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
  if (anchor.quote === "") {
    // Defensive: an anchor must carry quote at creation. Empty quote → outdated.
    return { status: "outdated" };
  }

  const lineMap = buildLineMap(oldSource, currentSource);
  const newSl = lineMap.get(anchor.range.sl);
  const newEl = lineMap.get(anchor.range.el);
  if (newSl === undefined || newEl === undefined) {
    return { status: "outdated" };
  }

  const newRange: Range = {
    sl: newSl,
    sc: anchor.range.sc,
    el: newEl,
    ec: anchor.range.ec,
  };

  const extracted = extractTextAtRange(currentSource, newRange);
  return extracted === anchor.quote
    ? { status: "mapped", range: newRange }
    : { status: "shifted", range: newRange };
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
