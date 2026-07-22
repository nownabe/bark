// AppState — the derived view-model layer between LocalState/RemoteState
// and React. Purely computed from inputs; never persisted.
//
// See docs/adr/0002-data-model.md §4.

import { extractSuggestionBlock } from "../suggest";
import { type DisplayPosition, reanchor } from "./reanchor";
import type {
  ChangedFile,
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

  /** Files available at the PR's current head SHA, sorted by path. The UI
   *  reads its source-viewer file list from here so it never touches
   *  RemoteState directly. Empty until both PullRequest and matching
   *  FileContent entries are present. */
  currentFiles: FileContent[];

  /** The PR's changed `.md` files still present at head (Bark's review
   *  scope), in GitHub API order, patches included so the UI can derive
   *  in-diff ranges. Empty until the remote snapshot carries the
   *  changed-file listing. */
  changedMarkdownFiles: ChangedFile[];
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
  const currentFiles = buildCurrentFiles(remote.fileContents, headSha);

  return {
    role: computeRole(remote.viewer, remote.pullRequest),
    pullRequest: remote.pullRequest,
    viewer: remote.viewer,
    commentViews,
    threadGroups,
    currentFiles,
    changedMarkdownFiles: buildChangedMarkdownFiles(remote.changedFiles),
  };
}

function buildChangedMarkdownFiles(changed: ChangedFile[] | undefined): ChangedFile[] {
  if (!changed) return [];
  return changed.filter((f) => f.path.toLowerCase().endsWith(".md") && f.status !== "removed");
}

function buildCurrentFiles(files: FileContent[], headSha: string | null): FileContent[] {
  if (!headSha) return [];
  const seen = new Set<string>();
  const out: FileContent[] = [];
  for (const f of files) {
    if (f.sha !== headSha || seen.has(f.path)) continue;
    seen.add(f.path);
    out.push(f);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ---- Body parsing -------------------------------------------------------

export function parseSuggestion(body: string): {
  kind: "comment" | "suggestion";
  replacement?: string;
} {
  // Delegate to the shared, fence-length-aware extractor (lib/suggest.ts) so
  // both layers agree on how suggestions parse — in particular a longer outer
  // fence wrapping an inner ``` code fence (issue #195).
  const replacement = extractSuggestionBlock(body);
  return replacement === null ? { kind: "comment" } : { kind: "suggestion", replacement };
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
