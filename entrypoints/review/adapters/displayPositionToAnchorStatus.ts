// Adapter from the new data layer's DisplayPosition.status to the
// legacy AnchorStatus values that App.tsx's badge code consumes.
//
// AnchorStatus is a 3-state value ('current', 'reanchored', 'outdated')
// that the badge UI inspects via STATUS_LABEL (uiHelpers). DisplayPosition
// is the new layer's richer 4-state version — `mapped` and `shifted` both
// indicate a successful LCS re-anchor, with the latter carrying a quote
// mismatch. Both collapse to 'reanchored' as far as the legacy UI cares
// (it can't tell `mapped` from `shifted` apart anyway).

import type { DisplayPosition } from "../../../lib/pr/reanchor";
import type { AnchorStatus } from "../../../lib/reanchor";

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
