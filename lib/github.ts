// Pure GitHub display helpers: PR lifecycle status, suggestion blocks, avatar
// and blob URLs. No network and no data model — the HTTP client lives in
// lib/pr/github-api, the typed fetchers in lib/pr/remote-fetcher, and every
// shared type in lib/pr/types.

import type { PrRef } from "./pr/types";

export type PullStatus = "draft" | "merged" | "open" | "closed";

/** Collapse the GitHub PR fields into a single display status. */
export function pullStatus(info: { state: string; draft?: boolean; merged?: boolean }): PullStatus {
  if (info.merged) return "merged";
  if (info.draft) return "draft";
  return info.state === "closed" ? "closed" : "open";
}

/** A GitHub suggestion block. Shows "Apply suggestion" when in-diff.
 *
 * Picks a fence length one longer than the longest backtick run inside
 * `replacement` (min 3) so an inner ``` code fence in the suggestion content
 * can't prematurely close the outer block per CommonMark. */
export function buildSuggestionBlock(replacement: string): string {
  let longest = 0;
  for (const m of replacement.matchAll(/`+/g)) {
    if (m[0].length > longest) longest = m[0].length;
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}suggestion\n${replacement}\n${fence}`;
}

/** Public avatar URL for a GitHub login (github.com/<login>.png redirects to the CDN). */
export function avatarUrl(login: string, size = 40): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=${size}`;
}

/** Blob permalink for out-of-diff comments — GitHub review comments can only
 * target diff-hunk lines, so out-of-diff feedback is posted as a regular
 * comment quoting this permalink. */
export function buildBlobPermalink(
  ref: PrRef,
  path: string,
  sha: string,
  startLine: number,
  endLine: number,
): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const lines = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
  return `https://github.com/${ref.owner}/${ref.repo}/blob/${sha}/${encoded}#${lines}`;
}
