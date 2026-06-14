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
  /** unified-diff(diff 内/外判定 §7.1 用)。大きい/binary だと undefined。 */
  patch?: string;
}

/** レビューコメント投稿の入力(RIGHT 側, §7.2)。 */
export interface ReviewCommentInput {
  path: string;
  /** 複数行の場合は終端行。 */
  line: number;
  side: 'RIGHT';
  /** 複数行選択のときのみ。 */
  start_line?: number;
  start_side?: 'RIGHT';
  body: string;
}

/** GitHub レビューコメント API の生レスポンス(必要フィールドのみ)。 */
export interface RawReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  user: { login: string } | null;
}

/** GitHub issue コメント API の生レスポンス(必要フィールドのみ)。 */
export interface RawIssueComment {
  id: number;
  body: string;
  user: { login: string } | null;
}

/** PR の head 情報。 */
export interface PullInfo {
  headSha: string;
  headRef: string;
}

const API_BASE = 'https://api.github.com';

/** UTF-8 安全な base64(contents API のコミット内容用。日本語も安全)。 */
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** GitHub の Suggestion ブロック(§7.3)。diff 内なら「Apply suggestion」が出る。 */
export function buildSuggestionBlock(replacement: string): string {
  return `\`\`\`suggestion\n${replacement}\n\`\`\``;
}

/** diff 外コメント用の blob パーマリンク(§7.1, D4)。 */
export function buildBlobPermalink(
  ref: PrRef,
  path: string,
  sha: string,
  startLine: number,
  endLine: number,
): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const lines = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
  return `https://github.com/${ref.owner}/${ref.repo}/blob/${sha}/${encoded}#${lines}`;
}

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

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  private async request(path: string, accept = 'application/vnd.github+json'): Promise<Response> {
    const res = await fetch(`${API_BASE}${path}`, { headers: this.headers({ Accept: accept }) });
    if (!res.ok) {
      throw new GitHubApiError(res.status, `GitHub API ${res.status} for ${path}`);
    }
    return res;
  }

  private async post(path: string, payload: unknown): Promise<void> {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new GitHubApiError(res.status, `GitHub API ${res.status} for ${path}: ${await res.text()}`);
    }
  }

  /** diff 内コメントを 1 レビューとして一括 Submit (§7.2, R4)。event 既定は COMMENT。 */
  async submitReview(
    ref: PrRef,
    input: { commitId?: string; comments: ReviewCommentInput[] },
  ): Promise<void> {
    await this.post(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, {
      commit_id: input.commitId,
      event: 'COMMENT',
      comments: input.comments,
    });
  }

  /** diff 外コメント = 通常 PR(issue)コメントを投稿 (§D4)。 */
  async createIssueComment(ref: PrRef, body: string): Promise<void> {
    await this.post(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, { body });
  }

  /** PR メタ。head の SHA(基準, §7.9)と ref(コミット先ブランチ, §7.4)。 */
  async getPull(ref: PrRef): Promise<PullInfo> {
    const res = await this.request(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
    const json = (await res.json()) as { head?: { sha?: string; ref?: string } };
    if (!json.head?.sha || !json.head?.ref) {
      throw new GitHubApiError(res.status, 'PR head not found');
    }
    return { headSha: json.head.sha, headRef: json.head.ref };
  }

  async getPullHeadSha(ref: PrRef): Promise<string> {
    return (await this.getPull(ref)).headSha;
  }

  /** 指定ブランチ時点のファイルの blob sha(コミット時の競合検出に必要, §7.4)。 */
  async getFileSha(ref: PrRef, path: string, branch: string): Promise<string> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await this.request(
      `/repos/${ref.owner}/${ref.repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
    );
    const json = (await res.json()) as { sha?: string };
    if (!json.sha) throw new GitHubApiError(res.status, 'file blob sha not found');
    return json.sha;
  }

  /** 単一ファイルを head ブランチにコミット (§7.4, R5)。Contents: Write が必要。 */
  async putFileContent(
    ref: PrRef,
    input: { path: string; content: string; message: string; sha: string; branch: string },
  ): Promise<void> {
    const encoded = input.path.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(`${API_BASE}/repos/${ref.owner}/${ref.repo}/contents/${encoded}`, {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        message: input.message,
        content: utf8ToBase64(input.content),
        sha: input.sha,
        branch: input.branch,
      }),
    });
    if (!res.ok) {
      throw new GitHubApiError(res.status, `GitHub API ${res.status} for PUT contents: ${await res.text()}`);
    }
  }

  /**
   * PR の変更済み `.md` ファイル一覧(削除を除く)。
   * TODO: per_page=100 を超える PR のページネーション(Link ヘッダ)対応。
   */
  async listMarkdownFiles(ref: PrRef): Promise<ChangedFile[]> {
    const res = await this.request(
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`,
    );
    const files = (await res.json()) as Array<{
      filename: string;
      status: string;
      patch?: string;
    }>;
    return files
      .filter((f) => f.filename.toLowerCase().endsWith('.md') && f.status !== 'removed')
      .map((f) => ({ path: f.filename, status: f.status, patch: f.patch }));
  }

  /** 既存のレビューコメント(diff 行に紐づく, §R6)。 */
  async listReviewComments(ref: PrRef): Promise<RawReviewComment[]> {
    const res = await this.request(
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments?per_page=100`,
    );
    return (await res.json()) as RawReviewComment[];
  }

  /** 既存の通常 PR コメント(issue コメント, diff 外コメントの保存先 §D4)。 */
  async listIssueComments(ref: PrRef): Promise<RawIssueComment[]> {
    const res = await this.request(
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100`,
    );
    return (await res.json()) as RawIssueComment[];
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
