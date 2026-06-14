// 既存コメントの正規化 — Design Doc §R6.
// レビューコメント / issue コメントの生レスポンスを、ツールの統一形に変換する。
// ツール製コメントは埋め込みメタデータから文字単位アンカーを復元し、メタデータが
// 無い「外来」コメントは GitHub の line 情報へ degrade する(§12-8)。
import { extractMetadata, type CommentMetadata } from './metadata';
import type { RawIssueComment, RawReviewComment } from './github';

export interface ExistingComment {
  id: number;
  source: 'review' | 'issue';
  author: string;
  /** メタデータを除いた可視本文。 */
  body: string;
  /** ツール製なら復元したアンカー、外来なら null。 */
  meta: CommentMetadata | null;
  /** degrade 用: GitHub ネイティブの path/line(review コメントのみ)。 */
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
      source: 'review',
      author: c.user?.login ?? 'unknown',
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
      source: 'issue',
      author: c.user?.login ?? 'unknown',
      body,
      meta,
    };
  });
  return [...fromReviews, ...fromIssues];
}
