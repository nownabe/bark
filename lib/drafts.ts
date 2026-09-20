// Per-PR client state still owned by chrome.storage: the reviewer's
// in-progress suggestion edits and the author's accept/reject decisions
// on submitted suggestions. Pending comment drafts moved to Repository in
// L7d-1; suggestion edits are scheduled to follow in L7d-2 and dismissed
// in L7d-3.
import { browser } from "wxt/browser";
import { storageKeys } from "./storage";
import type { AnchorRange } from "./metadata";
import type { PrRef } from "./github";

export interface PendingDraft {
  cid: string;
  path: string;
  /** Whether all lines are in-diff (true=review comment / false=regular comment). */
  inDiff: boolean;
  range: AnchorRange;
  quote: string;
  /** Source revision the draft was anchored against (createdAtSha). */
  sha: string;
  thread: string;
  /** Visible body. */
  body: string;
  /** comment | suggestion. */
  kind: "comment" | "suggestion";
  /** Replacement source lines for a suggestion (when kind==='suggestion'). */
  suggestion?: string;
  /** Blob permalink for out-of-diff comments. */
  permalink?: string;
  /** Why the last submit of this draft failed (Comment.lastError.message).
   *  Absent until a submit parks it back as a draft. */
  lastError?: string;
}

/**
 * The reviewer's in-progress suggestion edits for one file: the edited document
 * text plus the comment attached to each live suggestion (keyed by its cid).
 * Persisted per path so pending suggestions survive a reload, the way pending
 * comment drafts do (they are otherwise derived only from the in-memory editor
 * state and vanish when the file is re-fetched).
 */
export interface SuggestionEdit {
  /** The reviewer's edited document text. */
  source: string;
  /** The unedited base text the edit is diffed against, so the live suggestion
   * hunks can be recomputed for any file — not only the one open in the editor.
   *
   * Why not store a patch instead of a second full copy (issue #289): every
   * render needs the base for files that are *not* open (pending-suggestion
   * count, the meaningful-edit check), so a patch would have to be applied
   * against a `FileContent` fetched from GitHub first — network traffic to
   * render a local list. The duplication is bounded by the files edited in one
   * PR and is dropped by `evictStalePrStorage` once the PR merges. */
  base: string;
  /** The head sha `base` was fetched at. Lets the commit pipeline verify the
   * file didn't change upstream since the edit (issue #187); absent on edits
   * persisted before this field existed (treated as "made at the current
   * head", the pre-#187 behaviour). */
  baseSha?: string;
  comments: Record<string, string>;
}

function suggestionEditsKey(ref: PrRef): string {
  return `${storageKeys.pr(ref.owner, ref.repo, ref.number)}:suggestion-edits`;
}

export async function listSuggestionEdits(ref: PrRef): Promise<Record<string, SuggestionEdit>> {
  const key = suggestionEditsKey(ref);
  const result = await browser.storage.local.get(key);
  return (result[key] as Record<string, SuggestionEdit> | undefined) ?? {};
}

export async function saveSuggestionEdits(
  ref: PrRef,
  edits: Record<string, SuggestionEdit>,
): Promise<void> {
  await browser.storage.local.set({ [suggestionEditsKey(ref)]: edits });
}

/** The author's pending "accepted, awaiting commit" decisions on submitted
 *  suggestions, keyed by GitHub comment id. Rejection is not stored here:
 *  it is expressed as a resolved thread on GitHub (ADR 0002 §7). */
export type SuggestionDecision = "accepted";

function dismissedKey(ref: PrRef): string {
  return `${storageKeys.pr(ref.owner, ref.repo, ref.number)}:dismissed-suggestions`;
}

export async function listDismissedSuggestions(
  ref: PrRef,
): Promise<Record<string, SuggestionDecision>> {
  const key = dismissedKey(ref);
  const result = await browser.storage.local.get(key);
  const stored = (result[key] as Record<string, string> | undefined) ?? {};
  // An earlier build persisted "rejected" here. Dropping those entries lets
  // the suggestion reappear once, instead of staying hidden forever in this
  // one browser while GitHub knows nothing about the rejection.
  return Object.fromEntries(
    Object.entries(stored).filter(([, decision]) => decision === "accepted"),
  ) as Record<string, SuggestionDecision>;
}

export async function saveDismissedSuggestions(
  ref: PrRef,
  decisions: Record<string, SuggestionDecision>,
): Promise<void> {
  await browser.storage.local.set({ [dismissedKey(ref)]: decisions });
}

/**
 * Clear the author's decisions for the given comment ids — used after a Submit
 * successfully commits + resolves those threads, so the queue empties.
 */
export async function clearAcceptedDecisions(ref: PrRef, commentIds: number[]): Promise<void> {
  const current = await listDismissedSuggestions(ref);
  const drop = new Set(commentIds.map((id) => String(id)));
  await saveDismissedSuggestions(
    ref,
    Object.fromEntries(Object.entries(current).filter(([id]) => !drop.has(id))),
  );
}
