// Normalizing existing comments — Design Doc §R6.
// Convert the raw responses for review / issue comments into the tool's unified shape.
// For tool-authored comments, restore the char-level anchor from embedded metadata;
// "foreign" comments without metadata degrade to GitHub's line info (§12-8).
import { extractMetadata, type CommentMetadata } from "./metadata";
import type { RawIssueComment, RawReviewComment } from "./github";

export interface ExistingComment {
  id: number;
  source: "review" | "issue";
  author: string;
  /** Visible body with metadata stripped. */
  body: string;
  /** The restored anchor for tool-authored comments, null for foreign ones. */
  meta: CommentMetadata | null;
  /** For degraded mode: GitHub-native path/line (review comments only). */
  path?: string;
  line?: number;
}

export function normalizeComments(
  reviews: RawReviewComment[],
  issues: RawIssueComment[],
): ExistingComment[] {
  const fromReviews: ExistingComment[] = reviews.map((c) => {
    const { body, meta } = extractMetadata(c.body);
    return {
      id: c.id,
      source: "review",
      author: c.user?.login ?? "unknown",
      body,
      meta,
      path: c.path,
      line: c.line ?? undefined,
    };
  });
  const fromIssues: ExistingComment[] = issues.map((c) => {
    const { body, meta } = extractMetadata(c.body);
    return {
      id: c.id,
      source: "issue",
      author: c.user?.login ?? "unknown",
      body,
      meta,
    };
  });
  return [...fromReviews, ...fromIssues];
}

/** True when every expected cid appears in the comments' embedded metadata. */
export function commentsContainCids(comments: ExistingComment[], cids: string[]): boolean {
  if (cids.length === 0) return true;
  const present = new Set<string>();
  for (const c of comments) if (c.meta?.cid) present.add(c.meta.cid);
  return cids.every((cid) => present.has(cid));
}

/**
 * Re-fetch comments until every just-submitted item (identified by its embedded
 * cid) is present, working around GitHub's read-after-write lag: a GET on
 * .../comments right after a POST .../reviews can momentarily omit the comments
 * the review just created, which made just-submitted items vanish from the
 * sidebar until the next reload.
 *
 * Polls up to `attempts` times with `delayMs` between tries, then returns the
 * last result regardless — a comment that never arrives must not hang the UI.
 */
export async function reloadCommentsUntil(
  fetchComments: () => Promise<ExistingComment[]>,
  expectedCids: string[],
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ExistingComment[]> {
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 400;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let comments = await fetchComments();
  for (let i = 1; i < attempts && !commentsContainCids(comments, expectedCids); i++) {
    await sleep(delayMs);
    comments = await fetchComments();
  }
  return comments;
}
