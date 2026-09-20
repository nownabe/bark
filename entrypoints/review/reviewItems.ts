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
import { lineColToOffset } from "../../lib/anchor";
import type { ExistingComment } from "../../lib/comments";
import type { PendingDraft, SuggestionEdit } from "../../lib/drafts";
import type { AnchorRange, CommentMetadata } from "../../lib/metadata";
import { contentDigest } from "../../lib/pr/metadata";
import type { DisplayPosition } from "../../lib/pr/reanchor";
import {
  diffToSuggestions,
  extractSuggestionBlock,
  isMeaningfulEdit,
  type SuggestionHunk,
} from "../../lib/suggest";

/** The viewer's capability in the review UI. */
export type Role = "author" | "reviewer";

/**
 * Derive the role from identity: "author" iff the authenticated viewer's login
 * matches the PR author's login (GitHub logins are case-insensitive). Any
 * missing side falls back to "reviewer" — the safe default that withholds the
 * author-only commit affordance without breaking the reviewer flow.
 */
export function deriveRole(
  viewerLogin: string | null | undefined,
  prAuthor: string | null | undefined,
): Role {
  if (!viewerLogin || !prAuthor) return "reviewer";
  return viewerLogin.toLowerCase() === prAuthor.toLowerCase() ? "author" : "reviewer";
}

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
  pos: PosKey;
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
  /** Head sha the edit's `base` was fetched at (SuggestionEdit.baseSha); the
   *  hunk's lines are in that sha's coordinates. Absent for legacy edits. */
  baseSha?: string;
}

/** Stable id for a live suggestion derived from a base→edited line hunk. */
export function liveSuggestionCid(h: { sl: number; el: number }): string {
  return `live:${h.sl}:${h.el}`;
}

/** Id of the Comment a hunk materialises into at submit.
 *
 *  A hunk identical in `(path, baseSha, range, replacement)` to a Comment
 *  already in LocalState *is* that Comment: retried if it is a parked draft,
 *  and not posted again if it is already synced (GitHub has it, with this
 *  exact content). Deriving the id instead of minting one is what makes that
 *  true after a failed post (issue #308); `quote` is implied by
 *  `(baseSha, path, range)` and left out. */
export function suggestionDraftCid(s: {
  path: string;
  baseSha: string;
  range: AnchorRange;
  replacement: string;
}): string {
  return `suggestion:${s.range.sl}-${s.range.el}:${contentDigest(`${s.path}\0${s.baseSha}\0${s.replacement}`)}`;
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
    baseSha?: string;
  },
): PendingSuggestion[] {
  return hunks.map((h) => {
    const cid = liveSuggestionCid(h);
    return {
      cid,
      path: opts.path,
      inDiff: opts.isInDiff(h.sl, h.el),
      // A line-based anchor is the single `quote`-at-`range` rule with
      // `sc = 1` and `ec` past the last quoted line (ADR 0002 §3, issue #276).
      range: {
        sl: h.sl,
        sc: 1,
        el: h.el,
        ec: h.quote.slice(h.quote.lastIndexOf("\n") + 1).length + 1,
      },
      quote: h.quote,
      replacement: h.replacement,
      body: opts.commentFor(cid),
      ...(opts.baseSha ? { baseSha: opts.baseSha } : {}),
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
        baseSha: edit.baseSha,
      });
    });
}

export type ReviewFacet = "pending" | "submitted" | "resolved";

export type ReviewEntry =
  | { kind: "thread"; sortPath: string; sortPos: PosKey; thread: ReviewThread }
  | { kind: "liveSuggestion"; sortPath: string; sortPos: PosKey; suggestion: PendingSuggestion };

/** Info needed to render an author-accepted suggestion in the pending list. */
export interface AcceptedSuggestionInfo {
  /** REST comment id of the submitted suggestion the author accepted. */
  commentId: number;
  path: string;
  quote: string;
  replacement: string;
  /** Source line of the accepted suggestion (for sort + display). */
  line: number;
}

/**
 * A flat list of what "Submit" will send. Reviewer-mode items: comment / suggestion.
 * Author-mode adds acceptedSuggestion (a thread to resolve on commit) and edit (a file
 * to include in the single batched commit).
 */
export type PendingItem =
  | { kind: "comment"; draft: PendingDraft }
  | { kind: "suggestion"; suggestion: PendingSuggestion }
  | {
      kind: "acceptedSuggestion";
      commentId: number;
      path: string;
      quote: string;
      replacement: string;
      line: number;
    }
  | { kind: "edit"; path: string };

/**
 * Whether a reply can be composed on this thread. A reply inherits the
 * thread's anchor, which needs one of:
 *  - a Bark-authored root (metadata carries path/range/quote),
 *  - a pending root draft, or
 *  - a foreign review root with a known line (GitHub-native path/line —
 *    the reply anchors to that line and posts via the review-reply
 *    endpoint).
 * A foreign issue comment (no path/line, and GitHub issue comments are
 * flat) can't take a reply; offering the composer there would silently
 * discard the text (issue #183).
 */
export function canReplyToThread(t: ReviewThread): boolean {
  if (t.rootComment?.meta || t.rootDraft) return true;
  const root = t.rootComment;
  return !!root && root.source === "review" && root.line !== undefined;
}

/**
 * The anchor a reply inherits from its thread — the three cases
 * `canReplyToThread` admits, in the same order; null when none applies.
 *
 * The sha travels with the range it belongs to: a Bark or draft root's range
 * is in that root's own sha, so stamping the head sha there would make
 * `reanchor` treat stale lines as current (issue #285). Only the foreign
 * review root anchors at the head, because GitHub's `line` is head-side.
 */
export function replyAnchor(
  t: ReviewThread,
  headSha: string | null,
): { path: string; range: AnchorRange; quote: string; thread: string; sha: string } | null {
  const root = t.rootComment;
  if (root?.meta) {
    const { path, range, quote, thread, sha } = root.meta;
    return { path, range, quote, thread, sha };
  }
  if (t.rootDraft) {
    const { path, range, quote, thread, sha } = t.rootDraft;
    return { path, range, quote, thread, sha };
  }
  if (root && root.source === "review" && root.path && root.line !== undefined) {
    return {
      path: root.path,
      range: { sl: root.line, sc: 1, el: root.line, ec: 1 },
      quote: "",
      thread: t.id,
      sha: headSha ?? "",
    };
  }
  return null;
}

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

// Position key: line dominates, column breaks ties. A [line, col] tuple rather
// than a packed integer (line * 100000 + col) — the packed form overflowed for
// columns >= 100000 on a single very long line, leaking into the next line's
// range and misordering entries (issue #196). Shared so the selection composer
// can be spliced into the (already position-sorted) entry list at the spot
// matching the selection's own line/column.
export type PosKey = [line: number, col: number];

export function sortPos(line: number, col: number): PosKey {
  return [line, col];
}

/** Compare two position keys: line first, then column. */
export function comparePos(a: PosKey, b: PosKey): number {
  return a[0] - b[0] || a[1] - b[1];
}

function posOf(range: AnchorRange): PosKey {
  return sortPos(range.sl, range.sc);
}

/**
 * Index at which to splice the selection composer into the position-sorted
 * review entries so it appears in document order (not pinned at the top). The
 * composer sorts *after* an entry at the same position, so a comment already on
 * the selected line stays above the new composer.
 */
export function composerInsertIndex(entries: { sortPos: PosKey }[], pos: PosKey): number {
  const i = entries.findIndex((e) => comparePos(e.sortPos, pos) > 0);
  return i === -1 ? entries.length : i;
}

function rank(path: string | undefined, currentPath: string): number {
  return path === currentPath ? 0 : 1;
}

// A line with no known column sorts at its start; 1e9 is the "unknown position"
// line, kept larger than any real line so anchorless roots sink to the end.
function threadPos(rootComment: ExistingComment | null, rootDraft: PendingDraft | null): PosKey {
  if (rootComment?.meta) return posOf(rootComment.meta.range);
  if (rootComment) return sortPos(rootComment.line ?? 1e9, 1);
  if (rootDraft) return posOf(rootDraft.range);
  return sortPos(1e9, 1);
}

/**
 * Compute the set of thread ids whose resolved state should be reflected in
 * the sidebar. Two sources are unioned:
 *
 *   1. The caller-provided `resolvedKeys` (the new data layer's
 *      `Thread.resolved`, mapped to reviewItems thread keys). This is the
 *      source of truth for current data — both Bark-authored and foreign.
 *   2. Legacy event-marker comments (`meta.event === "resolve" | "unresolve"`,
 *      highest GitHub id wins per thread). Only old PRs predating the
 *      data-layer rewrite still carry these; the new fetcher drops `event`
 *      because v2 represents resolved state on Thread directly.
 *
 * `buildSuggestionMarks` consults this so the in-editor overlay matches
 * the sidebar's resolved-state view.
 */
export function resolvedThreadIds(
  comments: ExistingComment[],
  opts?: { resolvedKeys?: ReadonlySet<string> },
): Set<string> {
  const latest = new Map<string, { id: number; event: "resolve" | "unresolve" }>();
  for (const c of comments) {
    if (!c.meta?.event) continue;
    const prev = latest.get(c.meta.thread);
    if (!prev || c.id > prev.id) latest.set(c.meta.thread, { id: c.id, event: c.meta.event });
  }
  const resolved = new Set<string>(opts?.resolvedKeys ?? []);
  for (const [thread, e] of latest) if (e.event === "resolve") resolved.add(thread);
  return resolved;
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
  opts?: {
    accepted?: (commentId: number) => boolean;
    /** Thread keys reported resolved by the new data layer. Unioned with
     *  the legacy event-marker derivation. */
    resolvedKeys?: ReadonlySet<string>;
  },
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
    // Key by the Bark metadata threadId, else by the data layer's threadKey
    // (== Thread entity id), so foreign comments group by their real GitHub
    // thread — and a reply draft keyed to the same thread id nests with
    // them. `solo:` is a last-resort fallback for comments with neither.
    group(c.meta?.thread || c.threadKey || `solo:${c.source}:${c.id}`).submitted.push(c);
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
    const resolvedByRepository = opts?.resolvedKeys?.has(id) ?? false;
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
      resolved: resolvedByRepository || resolvedByEvent || acceptedSuggestion,
    };
  });
  list.sort(
    (a, b) => rank(a.path, currentPath) - rank(b.path, currentPath) || comparePos(a.pos, b.pos),
  );
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
      .map((thread): ReviewEntry => ({
        kind: "thread",
        sortPath: thread.path ?? "",
        sortPos: thread.pos,
        thread,
      })),
    ...pendingSuggestions
      .filter((suggestion) => suggestion.path === currentPath)
      .map((suggestion): ReviewEntry => ({
        kind: "liveSuggestion",
        sortPath: suggestion.path,
        sortPos: posOf(suggestion.range),
        suggestion,
      })),
  ];
  entries.sort((a, b) => comparePos(a.sortPos, b.sortPos));
  return entries;
}

export function filterReviewEntries(
  entries: ReviewEntry[],
  facets: Set<ReviewFacet>,
): ReviewEntry[] {
  return entries.filter((e) => {
    if (e.kind === "liveSuggestion") return facets.has("pending");
    const t = e.thread;
    if (facets.has("resolved") && t.resolved) return true;
    // A pending draft is always in the submit scope (buildPendingItems has no
    // resolved check), so surface it under "pending" even on a resolved thread —
    // otherwise the draft vanishes from the sidebar yet Submit still posts it
    // (Pending (0) vs Submit (1), issue #193). Submitted content on a resolved
    // thread still hides under the resolved facet.
    if (facets.has("pending") && t.hasPending) return true;
    if (facets.has("submitted") && t.hasSubmitted && !t.resolved) return true;
    return false;
  });
}

/**
 * After "Submit review", the just-submitted drafts become submitted comments.
 * If the list was filtered to "Pending" only, it would now look empty, so make
 * sure "submitted" is on — while preserving the user's other facet choices
 * (notably their "resolved" preference, which must not be forced on).
 */
export function revealSubmittedFacets(prev: Set<ReviewFacet>): Set<ReviewFacet> {
  return new Set<ReviewFacet>([...prev, "submitted"]);
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

/**
 * Pending items shown in author mode: comment drafts (incl. replies),
 * file-level edits (one per path with `source !== base`), and accepted
 * suggestions (one per dismissed-accepted entry). The single batched commit
 * the author Submit produces is summarized from these — see summarizePending.
 *
 * An `edit` item is NOT emitted for a file that has any accepted suggestion:
 * accepting a suggestion mutates the source (so the file IS in the commit) but
 * is already represented by its own `acceptedSuggestion` item. Emitting both
 * double-counted a single user action in the Submit (n) counter.
 */
export function buildAuthorPendingItems(
  drafts: PendingDraft[],
  edits: Record<string, SuggestionEdit>,
  accepted: AcceptedSuggestionInfo[],
): PendingItem[] {
  const acceptedPaths = new Set(accepted.map((a) => a.path));
  const editItems: PendingItem[] = Object.keys(edits)
    .sort((a, b) => a.localeCompare(b))
    .filter((path) => {
      const e = edits[path];
      return (
        typeof e?.base === "string" &&
        typeof e?.source === "string" &&
        isMeaningfulEdit(e.base, e.source) &&
        !acceptedPaths.has(path)
      );
    })
    .map((path): PendingItem => ({ kind: "edit", path }));
  const acceptedItems: PendingItem[] = accepted.map((a): PendingItem => ({
    kind: "acceptedSuggestion",
    commentId: a.commentId,
    path: a.path,
    quote: a.quote,
    replacement: a.replacement,
    line: a.line,
  }));
  return [
    ...drafts.map((draft): PendingItem => ({ kind: "comment", draft })),
    ...acceptedItems,
    ...editItems,
  ];
}

export function pendingItemPath(item: PendingItem): string {
  switch (item.kind) {
    case "comment":
      return item.draft.path;
    case "suggestion":
      return item.suggestion.path;
    case "acceptedSuggestion":
      return item.path;
    case "edit":
      return item.path;
  }
}

/**
 * Group pending items by file for the submit-review confirmation (which spans all
 * files, unlike the per-file sidebar). Groups are sorted by path, items by line.
 * Author-mode `edit` items have no line — they sort to the end.
 */
export function groupPendingByFile(items: PendingItem[]): { path: string; items: PendingItem[] }[] {
  const lineOf = (i: PendingItem): number => {
    switch (i.kind) {
      case "suggestion":
        return i.suggestion.range.sl;
      case "comment":
        return i.draft.range.sl;
      case "acceptedSuggestion":
        return i.line;
      case "edit":
        return Number.POSITIVE_INFINITY;
    }
  };
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

/** Counts for the single batched commit author Submit produces. */
export interface SubmitCommitGroup {
  /** Files with `source !== base` that will be in the commit. */
  editedFiles: number;
  /** Reviewer suggestions accepted by the author — their threads will be resolved. */
  acceptances: number;
}

/**
 * Summarize what "Submit" will actually post.
 *
 * Reviewer-mode routing mirrors submitReview: in-diff items become a single
 * GitHub review with inline comments; out-of-diff items become separate PR
 * (issue) comments. Author-mode adds a `commit` group covering the single
 * batched Git commit (one per file edited + the threads to resolve for
 * accepted suggestions).
 */
export interface SubmitSummary {
  total: number;
  /** In-diff items — sent as one review with inline comments. */
  review: SubmitGroup;
  /** Out-of-diff items — posted directly on the PR as separate comments. */
  direct: SubmitGroup;
  /** Author's single batched commit. Always present; zero in reviewer-only flows. */
  commit: SubmitCommitGroup;
}

export function summarizePending(items: PendingItem[]): SubmitSummary {
  const empty = (): SubmitGroup => ({ comments: 0, suggestions: 0, total: 0 });
  const summary: SubmitSummary = {
    total: items.length,
    review: empty(),
    direct: empty(),
    commit: { editedFiles: 0, acceptances: 0 },
  };
  // editedFiles is the count of unique paths in the commit — every
  // acceptedSuggestion implies its file is in the commit too (the accept
  // mutated the source), so unite the path sets to avoid undercounting after
  // `buildAuthorPendingItems` suppresses redundant `edit` items.
  const commitPaths = new Set<string>();
  for (const item of items) {
    if (item.kind === "edit") {
      commitPaths.add(item.path);
      continue;
    }
    if (item.kind === "acceptedSuggestion") {
      commitPaths.add(item.path);
      summary.commit.acceptances++;
      continue;
    }
    const isSuggestion = item.kind === "suggestion" ? true : item.draft.kind === "suggestion";
    const inDiff = item.kind === "suggestion" ? item.suggestion.inDiff : item.draft.inDiff;
    const group = inDiff ? summary.review : summary.direct;
    group.total++;
    if (isSuggestion) group.suggestions++;
    else group.comments++;
  }
  summary.commit.editedFiles = commitPaths.size;
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
 * The span is sized by the quoted old text rather than by the anchor's end
 * column: the quote is the source text at the range (ADR 0002 §3), so the two
 * agree, and the quote stays right after re-anchoring moved the position.
 */
export function buildSuggestionMarks(args: {
  comments: ExistingComment[];
  source: string;
  lineStarts: number[];
  currentPath: string;
  dismissed: Record<string, unknown>;
  /** Lookup each Bark comment's reanchored position (new layer's CommentView
   *  .displayPosition). Returns null when the cid has no view, which is
   *  treated the same as "outdated". */
  displayPositionFor: (cid: string) => DisplayPosition | null | undefined;
  /** Thread keys reported resolved by the new data layer. */
  resolvedKeys?: ReadonlySet<string>;
}): SuggestionRender[] {
  const { comments, source, lineStarts, currentPath, dismissed, displayPositionFor, resolvedKeys } =
    args;
  const docLen = source.length;
  const resolved = resolvedThreadIds(comments, { resolvedKeys });
  const out: SuggestionRender[] = [];
  for (const c of comments) {
    if (c.meta?.kind !== "suggestion") continue;
    if (c.meta.path !== currentPath) continue;
    if (dismissed[c.id]) continue;
    if (resolved.has(c.meta.thread)) continue;
    const meta = c.meta as CommentMetadata;
    const dp = displayPositionFor(meta.cid);
    if (!dp || dp.status === "outdated") continue;
    const from = lineColToOffset(dp.range.sl, dp.range.sc, lineStarts);
    const to = from + (meta.quote?.length ?? 0);
    if (from < 0 || to > docLen || from >= to) continue;
    // Overlay only a target that is still byte-identical to the quoted
    // text — a "shifted" target would strike through the wrong characters
    // (issue #176).
    if (source.slice(from, to) !== meta.quote) continue;
    out.push({ from, to, replacement: extractSuggestionBlock(c.body) ?? "" });
  }
  return out;
}

/**
 * Counts for the pending / submitted / resolved filter facets, derived from the
 * (already current-file-scoped) entries so the tab numbers match the list.
 */
export function reviewEntryCounts(entries: ReviewEntry[]): {
  pending: number;
  submitted: number;
  resolved: number;
} {
  const count = (f: ReviewFacet) => filterReviewEntries(entries, new Set([f])).length;
  return { pending: count("pending"), submitted: count("submitted"), resolved: count("resolved") };
}
