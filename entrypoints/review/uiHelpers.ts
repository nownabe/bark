// Small, presentation-only helpers used across the review surface.
//
// Anything that is purely about turning data into a label / error message
// for the UI lives here. No React state, no fetchers, no side effects.

import type { PullStatus } from "../../lib/github";
import { GitHubApiError } from "../../lib/pr/github-api";
import type { DisplayPosition } from "../../lib/pr/reanchor";
import type { AnchorStatus } from "./adapters/displayPositionToAnchorStatus";

/** Preview = rendered Markdown view; Raw = source / line-numbered view. */
export type ViewMode = "raw" | "preview";

/** Translate an error from a GitHub call (or any thrown value) into the
 *  user-facing message we surface in notice banners / Snackbars. A couple
 *  of HTTP codes get a specific hint:
 *   - 401/403 → most commonly an auth issue (expired/under-scoped token)
 *   - 404      → repo/PR not visible to this token (often the App is not
 *                installed on the repo) */
export function errMessage(e: unknown): string {
  if (e instanceof GitHubApiError) {
    if (e.status === 401 || e.status === 403) {
      return `Authentication error (${e.status}). Check the token's permissions/expiry.`;
    }
    if (e.status === 404) return "Not Found (404). Check the repository / PR / token permissions.";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Re-anchor badge labels. The "current" anchor state is normal — we
 *  intentionally do NOT surface a label for it so the sidebar stays
 *  quiet until something is actually off. */
export const STATUS_LABEL: Partial<Record<AnchorStatus, string>> = {
  reanchored: "position shifted",
  outdated: "position not found",
};

/** Whether a submitted suggestion may be accepted given its reanchored
 *  position. `shifted` means the target text no longer matches the quote and
 *  `outdated` means it can't be located at all — applying either would
 *  corrupt the document (issue #176). A missing view (bootstrap in flight)
 *  is refused the same way. */
export function canAcceptSuggestion(dp: DisplayPosition | null | undefined): boolean {
  return dp?.status === "current" || dp?.status === "mapped";
}

/** Capitalised display labels for the PR's lifecycle state. */
export const PR_STATUS_LABEL: Record<PullStatus, string> = {
  open: "Open",
  merged: "Merged",
  draft: "Draft",
  closed: "Closed",
};

/** Author/reviewer floating switch is a dev-only affordance. Builds
 *  without `BARK_DEV_ROLE_SWITCH` hide it and keep the default reviewer
 *  role. */
export const DEV_ROLE_SWITCH = Boolean(import.meta.env.BARK_DEV_ROLE_SWITCH);

/** Public slug of the Bark GitHub App, used to build the install URL so
 *  a 404 / 403 (likely "not installed on this repo") can offer a
 *  one-click install. */
export const APP_SLUG = import.meta.env.BARK_GITHUB_APP_SLUG;

/** GitHub App install URL, or null when no slug is configured. */
export const installUrl: string | null = APP_SLUG
  ? `https://github.com/apps/${APP_SLUG}/installations/new`
  : null;
