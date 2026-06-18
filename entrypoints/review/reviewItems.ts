// Unified review-items model for the sidebar.
//
// The sidebar shows two kinds of list entries in one position-sorted list:
//   - threads: comment conversations grouped by thread id. A thread mixes
//     submitted comments (already on GitHub) and pending drafts (local replies
//     or new comments not yet submitted), so a reply to a comment shows nested
//     in the same thread instead of as a separate item.
//   - live suggestions: the reviewer's current editor edits, treated as pending
//     the moment they are made, each with its own attached comment.
// A header filter narrows the list to all / pending / submitted.
//
// Everything here is pure so it can be unit-tested without React/CodeMirror.
import type { ExistingComment } from "../../lib/comments";
import type { PendingDraft, SuggestionEdit } from "../../lib/drafts";
import type { AnchorRange, CommentMetadata } from "../../lib/metadata";
import { diffToSuggestions, extractSuggestionBlock, type SuggestionHunk } from "../../lib/suggest";
import { reanchorComment } from "../../lib/reanchor";

/** One message in a thread: either already submitted, or a pending local draft. */
export type ThreadMessage =
  | { kind: "submitted"; comment: ExistingComment }
  | { kind: "pending"; draft: PendingDraft };

export interface ReviewThread {
  id: string;
  messages: ThreadMessage[];
  /** First submitted comment (anchor/quote source, author accept/reject target). */
  rootComment: ExistingComment | null;
  /** First pending draft, used as the anchor when the thread has no submitted comment yet. */
  rootDraft: PendingDraft | null;
  path: string | undefined;
  pos: number;
  quote: string | undefined;
  hasPending: boolean;
  hasSubmitted: boolean;
  /** Resolved via a resolution event, or root is an accepted suggestion. */
  resolved: boolean;
}

/** A reviewer's live editor edit, surfaced as a pending suggestion. */
export interface PendingSuggestion {
  cid: string;
  path: string;
  inDiff: boolean;
  range: AnchorRange;
  quote: string;
  replacement: string;
  body: string;
}

/** Stable id for a live suggestion derived from a base→edited line hunk. */
export function liveSuggestionCid(h: { sl: number; el: number }): string {
  return `live:${h.sl}:${h.el}`;
}

/**
 * Turn the reviewer's live edit hunks into pending suggestions, each carrying
 * its own attached comment (its GitHub "first comment", bundled into the same
 * comment as the suggestion block on submit).
 */
export function buildPendingSuggestions(
  hunks: SuggestionHunk[],
  opts: {
    path: string;
    isInDiff: (sl: number, el: number) => boolean;
    commentFor: (cid: string) => string;
  },
): PendingSuggestion[] {
  return hunks.map((h) => {
    const cid = liveSuggestionCid(h);
    return {
      cid,
      path: opts.path,
      inDiff: opts.isInDiff(h.sl, h.el),
      range: { sl: h.sl, sc: 1, el: h.el, ec: 1 },
      quote: h.quote,
      replacement: h.replacement,
      body: opts.commentFor(cid),
    };
  });
}

/**
 * Gather pending suggestions across ALL files from their persisted edits, for the
 * submit-review scope (button count, confirm modal, submit). Unlike the sidebar
 * — which shows only the open file — submit spans every file, so suggestions must
 * be recomputed from each file's stored base→source edit, mirroring how pending
 * comment drafts already span all files. Groups are emitted path-sorted.
 */
export function buildAllPendingSuggestions(
  edits: Record<string, SuggestionEdit>,
  isInDiff: (path: string, sl: number, el: number) => boolean,
): PendingSuggestion[] {
  return Object.keys(edits)
    .sort((a, b) => a.localeCompare(b))
    .flatMap((path) => {
      const edit = edits[path];
      // Edits persisted before `base` existed can't be diffed — skip them rather
      // than crash diffToSuggestions on an undefined source/base.
      if (typeof edit.base !== "string" || typeof edit.source !== "string") return [];
      return buildPendingSuggestions(diffToSuggestions(edit.base, edit.source), {
        path,
        isInDiff: (sl, el) => isInDiff(path, sl, el),
        commentFor: (cid) => edit.comments[cid] ?? "",
      });
    });
}

export type ReviewFilter = "all" | "pending" | "submitted";

export type ReviewEntry =
  | { kind: "thread"; sortPath: string; sortPos: number; thread: ReviewThread }
  | { kind: "liveSuggestion"; sortPath: string; sortPos: number; suggestion: PendingSuggestion };

/** A flat list of what "Submit review" will send — for the confirm modal & counts. */
export type PendingItem =
  | { kind: "comment"; draft: PendingDraft }
  | { kind: "suggestion"; suggestion: PendingSuggestion };

/** A thread's highlighted span in the body, used to map an editor click to a thread. */
export interface ThreadRange {
  id: string;
  from: number;
  to: number;
}

/**
 * Find the thread whose highlighted span contains the given body offset, so
 * clicking commented (highlighted) text emphasizes that comment. Boundaries are
 * inclusive; when ranges nest, the narrowest containing span wins.
 */
export function threadRangeAt(ranges: ThreadRange[], offset: number): ThreadRange | null {
  let best: ThreadRange | null = null;
  for (const r of ranges) {
    if (offset >= r.from && offset <= r.to && (!best || r.to - r.from < best.to - best.from)) {
      best = r;
    }
  }
  return best;
}

// Position key: line dominates, column breaks ties.
function posOf(range: AnchorRange): number {
  return range.sl * 100000 + range.sc;
}

function rank(path: string | undefined, currentPath: string): number {
  return path === currentPath ? 0 : 1;
}

function threadPos(rootComment: ExistingComment | null, rootDraft: PendingDraft | null): number {
  if (rootComment?.meta) return posOf(rootComment.meta.range);
  if (rootComment) return (rootComment.line ?? 1e9) * 100000;
  if (rootDraft) return posOf(rootDraft.range);
  return 1e9 * 100000;
}

/**
 * Group submitted comments and pending drafts into threads by thread id, sorted
 * current-path-first then by position. Submitted comments come before pending
 * ones within a thread; submitted comments are ordered by GitHub id.
 */
export function buildThreads(
  comments: ExistingComment[],
  drafts: PendingDraft[],
  currentPath: string,
  opts?: { accepted?: (commentId: number) => boolean },
): ReviewThread[] {
  const order: string[] = [];
  const groups = new Map<string, { submitted: ExistingComment[]; pending: PendingDraft[] }>();
  const group = (key: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { submitted: [], pending: [] };
      groups.set(key, g);
      order.push(key);
    }
    return g;
  };
  // Resolution events are hidden markers: collect the latest per thread, but keep
  // them out of the visible messages/root.
  const latestEvent = new Map<string, { id: number; event: "resolve" | "unresolve" }>();
  for (const c of comments) {
    if (c.meta?.event) {
      const t = c.meta.thread;
      const prev = latestEvent.get(t);
      if (!prev || c.id > prev.id) latestEvent.set(t, { id: c.id, event: c.meta.event });
      continue;
    }
    group(c.meta?.thread || `solo:${c.source}:${c.id}`).submitted.push(c);
  }
  for (const d of drafts) group(d.thread).pending.push(d);

  const list: ReviewThread[] = order.map((id) => {
    const g = groups.get(id)!;
    const submitted = [...g.submitted].sort((a, b) => a.id - b.id);
    const pending = g.pending;
    const rootComment = submitted[0] ?? null;
    const rootDraft = pending[0] ?? null;
    const messages: ThreadMessage[] = [
      ...submitted.map((comment): ThreadMessage => ({ kind: "submitted", comment })),
      ...pending.map((draft): ThreadMessage => ({ kind: "pending", draft })),
    ];
    const resolvedByEvent = latestEvent.get(id)?.event === "resolve";
    const acceptedSuggestion =
      rootComment?.meta?.kind === "suggestion" && (opts?.accepted?.(rootComment.id) ?? false);
    return {
      id,
      messages,
      rootComment,
      rootDraft,
      path: rootComment?.meta?.path ?? rootComment?.path ?? rootDraft?.path,
      pos: threadPos(rootComment, rootDraft),
      quote: rootComment?.meta?.quote ?? rootDraft?.quote,
      hasPending: pending.length > 0,
      hasSubmitted: submitted.length > 0,
      resolved: resolvedByEvent || acceptedSuggestion,
    };
  });
  list.sort((a, b) => rank(a.path, currentPath) - rank(b.path, currentPath) || a.pos - b.pos);
  return list;
}

/**
 * Entries to show in the sidebar for the file currently open in the editor.
 * Only items anchored to currentPath are included — review of one file at a time
 * — sorted by position. Items on other files are reachable by switching files.
 */
export function buildReviewEntries(args: {
  threads: ReviewThread[];
  pendingSuggestions: PendingSuggestion[];
  currentPath: string;
}): ReviewEntry[] {
  const { threads, pendingSuggestions, currentPath } = args;
  const entries: ReviewEntry[] = [
    ...threads
      .filter((thread) => thread.path === currentPath)
      .map(
        (thread): ReviewEntry => ({
          kind: "thread",
          sortPath: thread.path ?? "",
          sortPos: thread.pos,
          thread,
        }),
      ),
    ...pendingSuggestions
      .filter((suggestion) => suggestion.path === currentPath)
      .map(
        (suggestion): ReviewEntry => ({
          kind: "liveSuggestion",
          sortPath: suggestion.path,
          sortPos: posOf(suggestion.range),
          suggestion,
        }),
      ),
  ];
  entries.sort((a, b) => a.sortPos - b.sortPos);
  return entries;
}

export function filterReviewEntries(entries: ReviewEntry[], filter: ReviewFilter): ReviewEntry[] {
  if (filter === "all") return entries;
  return entries.filter((e) => {
    if (e.kind === "liveSuggestion") return filter === "pending";
    return filter === "pending" ? e.thread.hasPending : e.thread.hasSubmitted;
  });
}

export function buildPendingItems(
  drafts: PendingDraft[],
  pendingSuggestions: PendingSuggestion[],
): PendingItem[] {
  return [
    ...drafts.map((draft): PendingItem => ({ kind: "comment", draft })),
    ...pendingSuggestions.map((suggestion): PendingItem => ({ kind: "suggestion", suggestion })),
  ];
}

export function pendingItemPath(item: PendingItem): string {
  return item.kind === "suggestion" ? item.suggestion.path : item.draft.path;
}

/**
 * Group pending items by file for the submit-review confirmation (which spans all
 * files, unlike the per-file sidebar). Groups are sorted by path, items by line.
 */
export function groupPendingByFile(items: PendingItem[]): { path: string; items: PendingItem[] }[] {
  const lineOf = (i: PendingItem) =>
    i.kind === "suggestion" ? i.suggestion.range.sl : i.draft.range.sl;
  const groups = new Map<string, PendingItem[]>();
  for (const item of items) {
    const p = pendingItemPath(item);
    const g = groups.get(p);
    if (g) g.push(item);
    else groups.set(p, [item]);
  }
  return [...groups.entries()]
    .map(([path, list]) => ({ path, items: [...list].sort((a, b) => lineOf(a) - lineOf(b)) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Counts of comments vs suggestions in a group of pending items. */
export interface SubmitGroup {
  comments: number;
  suggestions: number;
  total: number;
}

/**
 * Summarize what "Submit review" will actually post, mirroring submitReview's
 * routing: in-diff items go out as a single GitHub review with inline comments;
 * out-of-diff items are posted directly as separate PR (issue) comments.
 */
export interface SubmitSummary {
  total: number;
  /** In-diff items — sent as one review with inline comments. */
  review: SubmitGroup;
  /** Out-of-diff items — posted directly on the PR as separate comments. */
  direct: SubmitGroup;
}

export function summarizePending(items: PendingItem[]): SubmitSummary {
  const empty = (): SubmitGroup => ({ comments: 0, suggestions: 0, total: 0 });
  const summary: SubmitSummary = { total: items.length, review: empty(), direct: empty() };
  for (const item of items) {
    const isSuggestion = item.kind === "suggestion" ? true : item.draft.kind === "suggestion";
    const inDiff = item.kind === "suggestion" ? item.suggestion.inDiff : item.draft.inDiff;
    const group = inDiff ? summary.review : summary.direct;
    group.total++;
    if (isSuggestion) group.suggestions++;
    else group.comments++;
  }
  return summary;
}

/** A submitted suggestion's span + replacement, for rendering over the body. */
export interface SuggestionRender {
  from: number;
  to: number;
  replacement: string;
}

/**
 * Build the spans for submitted suggestions to render over the editor body.
 *
 * Suggestions store a *line-based* anchor (column 1 → column 1), so when the
 * comment's sha matches the head, the stored start/end offsets collapse to zero
 * width for a single-line replacement and the suggestion would silently vanish.
 * Size the span by the quoted old text instead (it covers exactly the replaced
 * lines), which is also correct after re-anchoring to a moved position.
 */
export function buildSuggestionMarks(args: {
  comments: ExistingComment[];
  source: string;
  lineStarts: number[];
  headSha: string;
  currentPath: string;
  dismissed: Record<string, unknown>;
  /** createdAtSha source per `${sha}:${path}`, for diff-based re-anchoring. */
  oldSources?: Record<string, string>;
}): SuggestionRender[] {
  const { comments, source, lineStarts, headSha, currentPath, dismissed, oldSources } = args;
  const docLen = source.length;
  return comments
    .filter((c) => c.meta?.kind === "suggestion" && c.meta.path === currentPath && !dismissed[c.id])
    .map((c) => {
      const meta = c.meta as CommentMetadata;
      const oldSource = meta.sha ? oldSources?.[`${meta.sha}:${meta.path}`] : undefined;
      const r = reanchorComment(source, lineStarts, meta, headSha, oldSource);
      const from = r.startOffset;
      const to = r.startOffset + (meta.quote?.length ?? 0);
      return { from, to, status: r.status, replacement: extractSuggestionBlock(c.body) ?? "" };
    })
    .filter((m) => m.status !== "outdated" && m.from >= 0 && m.to <= docLen && m.from < m.to)
    .map(({ from, to, replacement }): SuggestionRender => ({ from, to, replacement }));
}

/**
 * Counts for the all / pending / submitted filter tabs, derived from the
 * (already current-file-scoped) entries so the tab numbers match the list.
 */
export function reviewEntryCounts(entries: ReviewEntry[]): {
  all: number;
  pending: number;
  submitted: number;
} {
  return {
    all: entries.length,
    pending: filterReviewEntries(entries, "pending").length,
    submitted: filterReviewEntries(entries, "submitted").length,
  };
}
