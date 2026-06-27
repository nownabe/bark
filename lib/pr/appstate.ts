// AppState — the derived view-model layer between LocalState/RemoteState
// and React. Purely computed from inputs; never persisted.
//
// See docs/adr/0002-data-model.md §4.

import { type DisplayPosition, reanchor } from "./reanchor";
import type {
  Comment,
  FileContent,
  LocalId,
  LocalState,
  PullRequest,
  RemoteState,
  Thread,
  User,
} from "./types";

/** Top-level AppState — derived from LocalState + RemoteState + session ctx. */
export type AppState = {
  /** "author" if the viewer is the PR author, "reviewer" otherwise. Null until
   *  RemoteState has both `viewer` and `pullRequest`. */
  role: "author" | "reviewer" | null;
  pullRequest: PullRequest | null;
  viewer: User | null;

  /** Per-Comment derived data, keyed by Comment.id. */
  commentViews: Map<LocalId, CommentView>;

  /** Threads grouped with their Comments (preserves LocalState ordering). */
  threadGroups: ThreadGroup[];
};

export type CommentView = {
  comment: Comment;
  /** Derived from the suggestion fence in `Comment.body`. */
  kind: "comment" | "suggestion";
  /** When `kind === "suggestion"`, the replacement text inside the fence. */
  replacement?: string;
  displayPosition: DisplayPosition;
  inDiff: boolean;
  /** Convenience: `comment.state === "draft"`. */
  isMyDraft: boolean;
};

export type ThreadGroup = {
  thread: Thread;
  comments: CommentView[];
};

/** Inputs the derivation needs beyond LocalState/RemoteState. */
export type DeriveContext = {
  /** Decides whether a Comment's anchor falls within the current PR diff. */
  isInDiff: (comment: Comment) => boolean;
};

export function deriveAppState(
  local: LocalState,
  remote: RemoteState,
  ctx: DeriveContext,
): AppState {
  const fileContents = indexFileContents(remote.fileContents);
  const headSha = remote.pullRequest?.headSha ?? null;

  const commentViews = new Map<LocalId, CommentView>();
  for (const comment of local.comments) {
    commentViews.set(comment.id, deriveCommentView(comment, fileContents, headSha, ctx));
  }

  const threadGroups = buildThreadGroups(local.threads, commentViews);

  return {
    role: computeRole(remote.viewer, remote.pullRequest),
    pullRequest: remote.pullRequest,
    viewer: remote.viewer,
    commentViews,
    threadGroups,
  };
}

// ---- Body parsing -------------------------------------------------------

const SUGGESTION_FENCE_RE = /```suggestion\r?\n([\s\S]*?)\r?\n?```/m;

export function parseSuggestion(body: string): {
  kind: "comment" | "suggestion";
  replacement?: string;
} {
  const match = SUGGESTION_FENCE_RE.exec(body);
  if (!match) {
    return { kind: "comment" };
  }
  return { kind: "suggestion", replacement: match[1] ?? "" };
}

// ---- CommentView build --------------------------------------------------

function deriveCommentView(
  comment: Comment,
  fileContents: Map<string, string>,
  headSha: string | null,
  ctx: DeriveContext,
): CommentView {
  const { kind, replacement } = parseSuggestion(comment.body);
  const displayPosition: DisplayPosition = headSha
    ? reanchor(
        comment.anchor,
        fileContents.get(fileKey(headSha, comment.path)) ?? "",
        headSha,
        fileContents.get(fileKey(comment.anchor.sha, comment.path)) ?? null,
      )
    : { status: "outdated" };
  return {
    comment,
    kind,
    replacement,
    displayPosition,
    inDiff: ctx.isInDiff(comment),
    isMyDraft: comment.state === "draft",
  };
}

// ---- Thread grouping ----------------------------------------------------

function buildThreadGroups(
  threads: Thread[],
  commentViews: Map<LocalId, CommentView>,
): ThreadGroup[] {
  const byThread = new Map<LocalId, CommentView[]>();
  for (const view of commentViews.values()) {
    const list = byThread.get(view.comment.threadId);
    if (list) {
      list.push(view);
    } else {
      byThread.set(view.comment.threadId, [view]);
    }
  }
  const knownIds = new Set(threads.map((t) => t.id));
  const groups: ThreadGroup[] = threads.map((thread) => ({
    thread,
    comments: byThread.get(thread.id) ?? [],
  }));
  // Synthesise a group for any threadId that owns comments but has no
  // corresponding Thread entity. This happens for foreign review and
  // foreign issue comments — they carry no Bark metadata, so neither
  // remote-fetcher's fetchThreads nor any local upsert produced a
  // matching Thread. Without this they would be invisible in the UI.
  for (const [threadId, comments] of byThread) {
    if (knownIds.has(threadId)) continue;
    groups.push({
      thread: { id: threadId, state: "synced", resolved: false },
      comments,
    });
  }
  return groups;
}

// ---- Role ---------------------------------------------------------------

function computeRole(
  viewer: User | null,
  pullRequest: PullRequest | null,
): "author" | "reviewer" | null {
  if (!viewer || !pullRequest) return null;
  return viewer.login.toLowerCase() === pullRequest.author.login.toLowerCase()
    ? "author"
    : "reviewer";
}

// ---- Helpers ------------------------------------------------------------

function fileKey(sha: string, path: string): string {
  return `${sha}\0${path}`;
}

function indexFileContents(files: FileContent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    out.set(fileKey(f.sha, f.path), f.source);
  }
  return out;
}
