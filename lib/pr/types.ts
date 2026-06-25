// Data model types for the new data layer.
// See docs/adr/0002-data-model.md for the design.

/** Locally-generated stable identifier. Primary identity for every entity. */
export type LocalId = string;

/** Information about the most recent failed sync attempt. */
export type ErrorInfo = {
  message: string;
  code?: string | number;
  detail?: unknown;
};

/** 1-based line/column range. */
export type Range = {
  sl: number;
  sc: number;
  el: number;
  ec: number;
};

/** Immutable creation-time anchor for a Comment. */
export type Anchor = {
  sha: string;
  range: Range;
  quote: string;
};

/** Inline user reference (used by Comment.author, PullRequest.author). */
export type Author = {
  login: string;
  avatarUrl?: string;
};

export type EntityState = "draft" | "syncing" | "synced";

/** A single review comment or reply. Suggestion-vs-comment is derived from `body`. */
export type Comment = {
  id: LocalId;
  state: EntityState;
  lastError?: ErrorInfo;

  /** GitHub REST id, populated by the Executor on successful sync. */
  remoteId?: number;
  /** Parent Thread.id (always set). */
  threadId: LocalId;
  /** Reply target within the same thread; absent for top-level. */
  parentLocalId?: LocalId;

  body: string;
  author: Author;

  path: string;
  /** Immutable; set at creation. */
  anchor: Anchor;
};

/** Conversation grouping with resolve state. */
export type Thread = {
  id: LocalId;
  state: EntityState;
  lastError?: ErrorInfo;

  /** GraphQL node id; needed for resolveReviewThread. */
  remoteThreadId?: string;
  resolved: boolean;
};

/** Author-mode pending file edit. Transient: draft -> syncing -> removed. */
export type FileEdit = {
  id: LocalId;
  state: "draft" | "syncing";
  lastError?: ErrorInfo;

  path: string;
  baseSha: string;
  editedSource: string;
};

/** Pull request metadata mirrored from GitHub. */
export type PullRequest = {
  owner: string;
  repo: string;
  number: number;

  title: string;
  body: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  author: Author;
};

/** The authenticated user (viewer). */
export type User = {
  login: string;
  avatarUrl?: string;
};

/** File content at a specific commit. Immutable per (sha, path). */
export type FileContent = {
  sha: string;
  path: string;
  source: string;
};

/** User-intended state, persisted to chrome.storage.local. */
export type LocalState = {
  comments: Comment[];
  threads: Thread[];
  fileEdits: FileEdit[];
};

/** Last-known GitHub state, in-memory only, refetched each session. */
export type RemoteState = {
  pullRequest: PullRequest | null;
  viewer: User | null;
  comments: Comment[];
  threads: Thread[];
  fileContents: FileContent[];
};

/** Empty LocalState helper. */
export function emptyLocalState(): LocalState {
  return { comments: [], threads: [], fileEdits: [] };
}

/** Empty RemoteState helper. */
export function emptyRemoteState(): RemoteState {
  return {
    pullRequest: null,
    viewer: null,
    comments: [],
    threads: [],
    fileContents: [],
  };
}
