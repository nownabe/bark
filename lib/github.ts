// Shared review types + pure GitHub display helpers.
//
// The HTTP client lives in lib/pr/github-api (`ghRequest` / `ghGraphQL` /
// `ghPaginate`, with ETag caching and GET retry per issue #9); the typed
// fetchers built on it live in lib/pr/remote-fetcher. This module carries
// only network-free types and helpers shared across the review surface.

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/** Precise anchor in the source. */
export interface CommentAnchor {
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
  /** Text for fuzzy matching during re-anchoring. */
  quotedText: string;
  /** Which document version the comment targets (basis for history tracking). */
  createdAtSha: string;
}

export type CommentKind = "comment" | "suggestion";
export type CommentStatus = "pending" | "open" | "addressed" | "resolved" | "outdated";

/** Comment structure shared by local drafts and embedded metadata. */
export interface ReviewComment {
  id: string;
  path: string;
  anchor: CommentAnchor;
  body: string;
  kind: CommentKind;
  /** Conversation grouping. */
  threadId: string;
  status: CommentStatus;
  /** Recorded when a later commit addresses the comment. */
  addressedBySha: string | null;
}

/** A changed file in the PR (near-raw form, before the .md filter). */
export interface ChangedFile {
  path: string;
  status: string; // added | modified | removed | renamed | ...
  /** unified-diff (for the in/out-of-diff decision). undefined when large/binary. */
  patch?: string;
}

/** PR head info + display metadata (title/body/author/status). */
export interface PullInfo {
  headSha: string;
  headRef: string;
  title: string;
  /** PR description (Markdown); empty string when none. */
  body: string;
  author: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
}

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
