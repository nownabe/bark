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

/** PR の変更ファイル(.md フィルタ前の生に近い形)。 */
export interface ChangedFile {
  path: string;
  status: string; // added | modified | removed | renamed | ...
}

const API_BASE = 'https://api.github.com';

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

/**
 * api.github.com を直接叩く REST クライアント(ブラウザ実行 / CORS 対応, §4)。
 * v1 認証は fine-grained PAT (§7.6)。実装範囲は #1 スライス(取得系)に限定。
 */
export class GitHubClient {
  constructor(private readonly token: string) {}

  private async request(path: string, accept = 'application/vnd.github+json'): Promise<Response> {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      throw new GitHubApiError(res.status, `GitHub API ${res.status} for ${path}`);
    }
    return res;
  }

  /** PR メタ。head の SHA を変更視覚化/アンカーの基準に使う (§7.9)。 */
  async getPullHeadSha(ref: PrRef): Promise<string> {
    const res = await this.request(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
    const json = (await res.json()) as { head?: { sha?: string } };
    const sha = json.head?.sha;
    if (!sha) throw new GitHubApiError(res.status, 'PR head sha not found');
    return sha;
  }

  /**
   * PR の変更済み `.md` ファイル一覧(削除を除く)。
   * TODO: per_page=100 を超える PR のページネーション(Link ヘッダ)対応。
   */
  async listMarkdownFiles(ref: PrRef): Promise<ChangedFile[]> {
    const res = await this.request(
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`,
    );
    const files = (await res.json()) as Array<{ filename: string; status: string }>;
    return files
      .filter((f) => f.filename.toLowerCase().endsWith('.md') && f.status !== 'removed')
      .map((f) => ({ path: f.filename, status: f.status }));
  }

  /** 指定 SHA 時点のファイル内容(raw テキスト = 正準ソース, §D9)。 */
  async getFileContent(ref: PrRef, path: string, sha: string): Promise<string> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await this.request(
      `/repos/${ref.owner}/${ref.repo}/contents/${encoded}?ref=${encodeURIComponent(sha)}`,
      'application/vnd.github.raw',
    );
    return res.text();
  }
}
