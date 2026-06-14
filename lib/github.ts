// GitHub API client + shared review types.
// Scaffold: types only (Design Doc §7.2 のコメントデータ構造)。
// 実装(getPull / listFiles / listReviews / submitReview / commit ...)は
// 難所#2/#3 のスライスで追加する。

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/** ソース上の精密アンカー (Design Doc §7.1 / §7.2). */
export interface CommentAnchor {
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
  /** 再アンカリング(§7.8)のためのファジーマッチ用テキスト。 */
  quotedText: string;
  /** どの時点のドキュメントに対する指摘か (§7.9 の履歴追跡の基礎)。 */
  createdAtSha: string;
}

export type CommentKind = 'comment' | 'suggestion';
export type CommentStatus =
  | 'pending'
  | 'open'
  | 'addressed'
  | 'resolved'
  | 'outdated';

/** ローカル下書き / 埋め込みメタデータと共通のコメント構造 (Design Doc §7.2). */
export interface ReviewComment {
  id: string;
  path: string;
  anchor: CommentAnchor;
  body: string;
  kind: CommentKind;
  /** 会話のまとまり (§7.1 の thread)。 */
  threadId: string;
  status: CommentStatus;
  /** 後続コミットで対応されたら記録 (§7.9)。 */
  addressedBySha: string | null;
}

/** GitHub API クライアント(placeholder)。 */
export class GitHubClient {
  constructor(private readonly token: string) {
    void this.token;
  }
  // TODO(next slice): getPull, listFiles, listCommits, listReviews,
  // submitReview, createIssueComment, putContents, compare ...
}
