// Unified review-items model for the sidebar — tasks 2 & 4.
//
// The sidebar shows three sources of items in a SINGLE position-sorted list:
//   - pending drafts (locally queued comments/suggestions, not yet submitted)
//   - live suggestions (the reviewer's current editor edits, treated as pending
//     the moment they are made — task 4)
//   - submitted comment threads (already on GitHub)
// A header filter narrows the list to all / pending / submitted (task 2).
//
// Everything here is pure so it can be unit-tested without React/CodeMirror.
import type { ExistingComment } from "../../lib/comments";
import type { PendingDraft } from "../../lib/drafts";
import type { AnchorRange } from "../../lib/metadata";
import type { SuggestionHunk } from "../../lib/suggest";

export interface ReviewThread {
  id: string;
  comments: ExistingComment[];
  root: ExistingComment;
  path: string | undefined;
  pos: number;
}

/** A reviewer's live editor edit, surfaced as a pending suggestion (task 4). */
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
  | { kind: "draft"; status: "pending"; sortPath: string; sortPos: number; draft: PendingDraft }
  | {
      kind: "liveSuggestion";
      status: "pending";
      sortPath: string;
      sortPos: number;
      suggestion: PendingSuggestion;
    }
  | {
      kind: "thread";
      status: "submitted";
      sortPath: string;
      sortPos: number;
      thread: ReviewThread;
    };

// Position key: line dominates, column breaks ties. Kept consistent with the
// previous inline sort in App.tsx.
function posOf(range: AnchorRange): number {
  return range.sl * 100000 + range.sc;
}

/** Group normalized comments into threads, sorted current-path-first then by position. */
export function buildThreads(comments: ExistingComment[], currentPath: string): ReviewThread[] {
  const map = new Map<string, ExistingComment[]>();
  for (const c of comments) {
    const key = c.meta?.thread || `solo:${c.source}:${c.id}`;
    const arr = map.get(key);
    if (arr) arr.push(c);
    else map.set(key, [c]);
  }
  const list: ReviewThread[] = [...map.entries()].map(([id, cs]) => {
    const root = cs[0];
    const pos = root.meta ? posOf(root.meta.range) : (root.line ?? 1e9) * 100000;
    return { id, comments: cs, root, path: root.meta?.path ?? root.path, pos };
  });
  list.sort((a, b) => rank(a.path, currentPath) - rank(b.path, currentPath) || a.pos - b.pos);
  return list;
}

function rank(path: string | undefined, currentPath: string): number {
  return path === currentPath ? 0 : 1;
}

export function buildReviewEntries(args: {
  drafts: PendingDraft[];
  threads: ReviewThread[];
  pendingSuggestions: PendingSuggestion[];
  currentPath: string;
}): ReviewEntry[] {
  const { drafts, threads, pendingSuggestions, currentPath } = args;
  const entries: ReviewEntry[] = [
    ...drafts.map(
      (draft): ReviewEntry => ({
        kind: "draft",
        status: "pending",
        sortPath: draft.path,
        sortPos: posOf(draft.range),
        draft,
      }),
    ),
    ...pendingSuggestions.map(
      (suggestion): ReviewEntry => ({
        kind: "liveSuggestion",
        status: "pending",
        sortPath: suggestion.path,
        sortPos: posOf(suggestion.range),
        suggestion,
      }),
    ),
    ...threads.map(
      (thread): ReviewEntry => ({
        kind: "thread",
        status: "submitted",
        sortPath: thread.path ?? "",
        sortPos: thread.pos,
        thread,
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
  return entries.filter((e) => e.status === filter);
}

export function reviewCounts(entries: ReviewEntry[]): {
  all: number;
  pending: number;
  submitted: number;
} {
  let pending = 0;
  let submitted = 0;
  for (const e of entries) {
    if (e.status === "pending") pending++;
    else submitted++;
  }
  return { all: entries.length, pending, submitted };
}
