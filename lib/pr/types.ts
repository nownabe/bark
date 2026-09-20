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

/** Immutable creation-time anchor for a Comment.
 *
 *  `quote` is the source text covered by `range` in `FileContent(sha, path)`
 *  (ADR 0002 §3). A line-based anchor — a suggestion hunk — is the case
 *  `sc = 1`, `ec = length(last quoted line) + 1`, not a second convention. */
export type Anchor = {
  sha: string;
  range: Range;
  quote: string;
};

/** Anchors written before ADR 0002 §3 defined `quote` stored line-based ranges
 *  as `sc = ec = 1`; bring them to the single rule so no consumer needs a
 *  second convention (issue #276). Applied at every ingress: the metadata
 *  parser and LocalState hydration. */
export function normalizeAnchor(a: Anchor): Anchor {
  if (a.quote === "" || a.range.sc !== 1 || a.range.ec !== 1) return a;
  const lastLine = a.quote.slice(a.quote.lastIndexOf("\n") + 1);
  if (lastLine === "") return a;
  return { ...a, range: { ...a.range, ec: lastLine.length + 1 } };
}

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
  /** Which GitHub object `remoteId` names; set together with it. */
  remoteKind?: "review" | "issue";
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

/** Conversation grouping with resolve state.
 *
 *  A Thread has exactly one remote identity: `remoteThreadId` for a GitHub
 *  review thread, or `remoteIssueCommentId` for an out-of-diff thread whose
 *  comments are issue comments (which have no GraphQL thread). Both are
 *  absent while the thread is a local draft. */
export type Thread = {
  id: LocalId;
  state: EntityState;
  lastError?: ErrorInfo;

  /** GraphQL node id (review threads); needed for resolveReviewThread. */
  remoteThreadId?: string;
  /** REST id of the root issue comment (out-of-diff threads); its hidden
   *  metadata carries the thread's resolved state (issue #270). */
  remoteIssueCommentId?: number;
  resolved: boolean;
  /** Remote-derived: the viewer may toggle `resolved`; undefined while draft. */
  viewerCanResolve?: boolean;
};

/** Whether the Thread exists on GitHub — as a review thread or as an
 *  out-of-diff thread rooted in a Bark issue comment. */
export function hasRemoteIdentity(
  t: Pick<Thread, "remoteThreadId" | "remoteIssueCommentId">,
): boolean {
  return t.remoteThreadId !== undefined || t.remoteIssueCommentId !== undefined;
}

/** Whether to offer Resolve/Reopen: the Thread is on GitHub and GitHub would
 *  accept the toggle from this viewer (issue #274). */
export function canResolveThread(t: Thread): boolean {
  return hasRemoteIdentity(t) && t.viewerCanResolve === true;
}

/** The remote mirror of a local Thread. Review threads join on the GraphQL
 *  node id (local and remote ids may differ); out-of-diff threads have no
 *  node id and join on the metadata threadId, which is the local id on both
 *  sides. */
export function findRemoteThread(remoteThreads: Thread[], t: Thread): Thread | undefined {
  return t.remoteThreadId !== undefined
    ? remoteThreads.find((r) => r.remoteThreadId === t.remoteThreadId)
    : remoteThreads.find((r) => r.id === t.id);
}

/** Author-mode pending file edit. Transient: draft -> syncing -> removed. */
export type FileEdit = {
  id: LocalId;
  state: "draft" | "syncing";
  lastError?: ErrorInfo;

  path: string;
  baseSha: string;
  editedSource: string;
  /** Threads to resolve once this edit is committed (accepted suggestions).
   *  A failed commit leaves them alone — nothing on GitHub claims the change
   *  landed, so no compensating unresolve is needed (issue #278). */
  resolveOnCommit?: LocalId[];
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
  /** Repository that owns `headRef`; null when the fork was deleted. */
  headRepo: { owner: string; repo: string } | null;
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
