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
