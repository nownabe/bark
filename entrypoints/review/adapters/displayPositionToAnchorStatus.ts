// Adapter from the data layer's DisplayPosition.status to the AnchorStatus
// the badge UI consumes.
//
// AnchorStatus is a 3-state value ('current', 'reanchored', 'outdated')
// the badge UI inspects via STATUS_LABEL (uiHelpers). DisplayPosition is the
// richer 4-state version — `mapped` and `shifted` both indicate a successful
// LCS re-anchor, with the latter carrying a quote mismatch. Both collapse to
// 'reanchored': the badge has no distinct affordance for a quote mismatch,
// and `canAccept` reads the DisplayPosition directly where that matters.

import type { DisplayPosition } from "../../../lib/pr/reanchor";

/** Anchor-status badge state surfaced in the sidebar / status indicator. */
export type AnchorStatus = "current" | "reanchored" | "outdated";

export function displayPositionToAnchorStatus(p: DisplayPosition): AnchorStatus {
  switch (p.status) {
    case "current":
      return "current";
    case "mapped":
    case "shifted":
      return "reanchored";
    case "outdated":
      return "outdated";
  }
}
