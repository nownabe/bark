// GitHub API client + shared review types.
// Scaffold: types only (the comment data structures from Design Doc §7.2).
// Implementations (getPull / listFiles / listReviews / submitReview / commit ...)
// are added in the challenge#2/#3 slices.

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/** Precise anchor in the source (Design Doc §7.1 / §7.2). */
export interface CommentAnchor {
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
  /** Text for fuzzy matching during re-anchoring (§7.8). */
  quotedText: string;
  /** Which document version the comment targets (basis for history tracking, §7.9). */
  createdAtSha: string;
}

export type CommentKind = "comment" | "suggestion";
export type CommentStatus = "pending" | "open" | "addressed" | "resolved" | "outdated";

/** Comment structure shared by local drafts and embedded metadata (Design Doc §7.2). */
export interface ReviewComment {
  id: string;
  path: string;
  anchor: CommentAnchor;
  body: string;
  kind: CommentKind;
  /** Conversation grouping (the thread in §7.1). */
  threadId: string;
  status: CommentStatus;
  /** Recorded when a later commit addresses the comment (§7.9). */
  addressedBySha: string | null;
}

/** A changed file in the PR (near-raw form, before the .md filter). */
export interface ChangedFile {
  path: string;
  status: string; // added | modified | removed | renamed | ...
  /** unified-diff (for the in/out-of-diff decision, §7.1). undefined when large/binary. */
  patch?: string;
}

/** Input for posting a review comment (RIGHT side, §7.2). */
export interface ReviewCommentInput {
  path: string;
  /** The end line when the range spans multiple lines. */
  line: number;
  side: "RIGHT";
  /** Only for multi-line selections. */
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

/** Raw response from the GitHub review comments API (only the fields we need). */
export interface RawReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  user: { login: string } | null;
}

/** Raw response from the GitHub issue comments API (only the fields we need). */
export interface RawIssueComment {
  id: number;
  body: string;
  user: { login: string } | null;
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

const API_BASE = "https://api.github.com";

/** UTF-8-safe base64 (for the contents API commit body; safe for non-ASCII too). */
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Extract the rel="next" URL from the `Link` header (null if absent). */
export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/** A GitHub suggestion block (§7.3). Shows "Apply suggestion" when in-diff. */
export function buildSuggestionBlock(replacement: string): string {
  return `\`\`\`suggestion\n${replacement}\n\`\`\``;
}

/** Public avatar URL for a GitHub login (github.com/<login>.png redirects to the CDN). */
export function avatarUrl(login: string, size = 40): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=${size}`;
}

/** Blob permalink for out-of-diff comments (§7.1, D4). */
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

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/**
 * REST client that calls api.github.com directly (runs in the browser / CORS-friendly, §4).
 * The bearer token comes from the GitHub App device flow (§7.6 / D10); this client
 * is auth-method agnostic and just sends whatever token it is given.
 */
export class GitHubClient {
  constructor(private readonly token: string) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    };
  }

  /** Build an error that distinguishes rate limiting (§10). */
  private errorFor(res: Response, where: string): GitHubApiError {
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      return new GitHubApiError(
        403,
        "GitHub API rate limit reached. Please wait a moment and retry.",
      );
    }
    return new GitHubApiError(res.status, `GitHub API ${res.status} for ${where}`);
  }

  private async request(path: string, accept = "application/vnd.github+json"): Promise<Response> {
    const res = await fetch(`${API_BASE}${path}`, { headers: this.headers({ Accept: accept }) });
    if (!res.ok) throw this.errorFor(res, path);
    return res;
  }

  /** Follow the Link header's rel="next" to fetch and concatenate all pages (pagination, §10). */
  private async getAllPages<T>(path: string): Promise<T[]> {
    let url: string | null = `${API_BASE}${path}`;
    const all: T[] = [];
    while (url) {
      const res: Response = await fetch(url, { headers: this.headers() });
      if (!res.ok) throw this.errorFor(res, url);
      all.push(...((await res.json()) as T[]));
      url = parseNextLink(res.headers.get("Link"));
    }
    return all;
  }

  private async post(path: string, payload: unknown): Promise<void> {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new GitHubApiError(
        res.status,
        `GitHub API ${res.status} for ${path}: ${await res.text()}`,
      );
    }
  }

  /** Submit all in-diff comments as a single review (§7.2, R4). event defaults to COMMENT. */
  async submitReview(
    ref: PrRef,
    input: { commitId?: string; comments: ReviewCommentInput[] },
  ): Promise<void> {
    await this.post(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, {
      commit_id: input.commitId,
      event: "COMMENT",
      comments: input.comments,
    });
  }

  /** Out-of-diff comment = post a regular PR (issue) comment (§D4). */
  async createIssueComment(ref: PrRef, body: string): Promise<void> {
    await this.post(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, { body });
  }

  /** PR metadata: head SHA/ref (§7.9/§7.4) plus title/body/author/status for display. */
  async getPull(ref: PrRef): Promise<PullInfo> {
    const res = await this.request(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
    const json = (await res.json()) as {
      head?: { sha?: string; ref?: string };
      title?: string;
      body?: string | null;
      user?: { login?: string } | null;
      state?: string;
      draft?: boolean;
      merged?: boolean;
    };
    if (!json.head?.sha || !json.head?.ref) {
      throw new GitHubApiError(res.status, "PR head not found");
    }
    return {
      headSha: json.head.sha,
      headRef: json.head.ref,
      title: json.title ?? "",
      body: json.body ?? "",
      author: json.user?.login ?? "unknown",
      state: json.state === "closed" ? "closed" : "open",
      draft: Boolean(json.draft),
      merged: Boolean(json.merged),
    };
  }

  async getPullHeadSha(ref: PrRef): Promise<string> {
    return (await this.getPull(ref)).headSha;
  }

  /** The file's blob sha at the given branch (needed for conflict detection on commit, §7.4). */
  async getFileSha(ref: PrRef, path: string, branch: string): Promise<string> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const res = await this.request(
      `/repos/${ref.owner}/${ref.repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
    );
    const json = (await res.json()) as { sha?: string };
    if (!json.sha) throw new GitHubApiError(res.status, "file blob sha not found");
    return json.sha;
  }

  /** Commit a single file to the head branch (§7.4, R5). Requires Contents: Write. */
  async putFileContent(
    ref: PrRef,
    input: { path: string; content: string; message: string; sha: string; branch: string },
  ): Promise<void> {
    const encoded = input.path.split("/").map(encodeURIComponent).join("/");
    const res = await fetch(`${API_BASE}/repos/${ref.owner}/${ref.repo}/contents/${encoded}`, {
      method: "PUT",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        message: input.message,
        content: utf8ToBase64(input.content),
        sha: input.sha,
        branch: input.branch,
      }),
    });
    if (!res.ok) {
      throw new GitHubApiError(
        res.status,
        `GitHub API ${res.status} for PUT contents: ${await res.text()}`,
      );
    }
  }

  /**
   * List the PR's changed `.md` files (excluding deletions).
   * TODO: handle pagination (Link header) for PRs exceeding per_page=100.
   */
  async listMarkdownFiles(ref: PrRef): Promise<ChangedFile[]> {
    const files = await this.getAllPages<{ filename: string; status: string; patch?: string }>(
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`,
    );
    return files
      .filter((f) => f.filename.toLowerCase().endsWith(".md") && f.status !== "removed")
      .map((f) => ({ path: f.filename, status: f.status, patch: f.patch }));
  }

  /** Existing review comments (tied to diff lines, §R6). */
  async listReviewComments(ref: PrRef): Promise<RawReviewComment[]> {
    return this.getAllPages<RawReviewComment>(
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments?per_page=100`,
    );
  }

  /** Existing regular PR comments (issue comments, where out-of-diff comments live, §D4). */
  async listIssueComments(ref: PrRef): Promise<RawIssueComment[]> {
    return this.getAllPages<RawIssueComment>(
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100`,
    );
  }

  /** File content at the given SHA (raw text = canonical source, §D9). */
  async getFileContent(ref: PrRef, path: string, sha: string): Promise<string> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const res = await this.request(
      `/repos/${ref.owner}/${ref.repo}/contents/${encoded}?ref=${encodeURIComponent(sha)}`,
      "application/vnd.github.raw",
    );
    return res.text();
  }
}
