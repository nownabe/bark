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
import type { PendingDraft } from "../../lib/drafts";
import type { AnchorRange } from "../../lib/metadata";
import type { SuggestionHunk } from "../../lib/suggest";

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
  for (const c of comments) group(c.meta?.thread || `solo:${c.source}:${c.id}`).submitted.push(c);
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
    };
  });
  list.sort((a, b) => rank(a.path, currentPath) - rank(b.path, currentPath) || a.pos - b.pos);
  return list;
}

export function buildReviewEntries(args: {
  threads: ReviewThread[];
  pendingSuggestions: PendingSuggestion[];
  currentPath: string;
}): ReviewEntry[] {
  const { threads, pendingSuggestions, currentPath } = args;
  const entries: ReviewEntry[] = [
    ...threads.map(
      (thread): ReviewEntry => ({
        kind: "thread",
        sortPath: thread.path ?? "",
        sortPos: thread.pos,
        thread,
      }),
    ),
    ...pendingSuggestions.map(
      (suggestion): ReviewEntry => ({
        kind: "liveSuggestion",
        sortPath: suggestion.path,
        sortPos: posOf(suggestion.range),
        suggestion,
      }),
    ),
  ];
  entries.sort(
    (a, b) =>
      rank(a.sortPath, currentPath) - rank(b.sortPath, currentPath) || a.sortPos - b.sortPos,
  );
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

export function reviewCounts(args: {
  drafts: PendingDraft[];
  pendingSuggestions: PendingSuggestion[];
  comments: ExistingComment[];
  threads: ReviewThread[];
}): { all: number; pending: number; submitted: number } {
  return {
    all: args.threads.length + args.pendingSuggestions.length,
    pending: args.drafts.length + args.pendingSuggestions.length,
    submitted: args.comments.length,
  };
}
