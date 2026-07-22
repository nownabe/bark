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

/** A GitHub user identity. Used for `Comment.author`, `PullRequest.author`,
 *  and `PRState.viewer`. */
export type User = {
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
  author: User;

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
  author: User;
};

/** File content at a specific commit. Immutable per (sha, path). */
export type FileContent = {
  sha: string;
  path: string;
  source: string;
};

/** A file changed by the PR, as returned by `GET /pulls/{n}/files`. */
export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  /** Unified-diff patch. May be absent for very large or binary files. */
  patch?: string;
};

/** Shape shared by `LocalState` and `RemoteState`. Both sides carry the same
 *  fields so the Reconciler can diff them field-by-field; individual fields are
 *  conventionally populated on one side or the other (see ADR 0002). */
export type PRState = {
  comments: Comment[];
  threads: Thread[];
  fileEdits: FileEdit[];
  fileContents: FileContent[];
  pullRequest: PullRequest | null;
  viewer: User | null;
};

/** User-intended state, persisted to chrome.storage.local. */
export type LocalState = PRState;

/** Last-known GitHub state, in-memory only, refetched each session.
 *
 *  `changedFiles` is remote-only and optional: the bootstrap orchestrator
 *  attaches the `GET /pulls/{n}/files` listing it already fetches for the
 *  isInDiff predicate, so AppState can derive the file selector from the
 *  Repository instead of a parallel fetch. It is deliberately NOT part of
 *  PRState — the Reconciler never diffs it and LocalState must not persist
 *  patches to storage. */
export type RemoteState = PRState & {
  changedFiles?: ChangedFile[];
};

/** Empty PRState helper (used for both LocalState and RemoteState). */
export function emptyState(): PRState {
  return {
    comments: [],
    threads: [],
    fileEdits: [],
    fileContents: [],
    pullRequest: null,
    viewer: null,
  };
}
