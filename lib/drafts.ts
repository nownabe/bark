// Local drafts (pending) — Design Doc §7.2 / §7.7 / R4.
// Accumulate comments locally as "pending" and flush them to GitHub in bulk on Submit.
// v1 holds lightweight data in chrome.storage.local (IndexedDB is introduced in a later
// slice that handles large data such as snapshots). Key: pr:{owner}/{repo}#{n}:drafts.
import { browser } from "wxt/browser";
import { storageKeys } from "./storage";
import type { AnchorRange } from "./metadata";
import type { PrRef } from "./github";

export interface PendingDraft {
  cid: string;
  path: string;
  /** Whether all lines are in-diff (true=review comment / false=regular comment, §7.1). */
  inDiff: boolean;
  range: AnchorRange;
  quote: string;
  /** createdAtSha (§7.9). */
  sha: string;
  thread: string;
  /** Visible body. */
  body: string;
  /** comment | suggestion (§7.3). */
  kind: "comment" | "suggestion";
  /** Replacement source lines for a suggestion (when kind==='suggestion'). */
  suggestion?: string;
  /** Blob permalink for out-of-diff comments. */
  permalink?: string;
}

function draftsKey(ref: PrRef): string {
  return `${storageKeys.pr(ref.owner, ref.repo, ref.number)}:drafts`;
}

export async function listDrafts(ref: PrRef): Promise<PendingDraft[]> {
  const key = draftsKey(ref);
  const result = await browser.storage.local.get(key);
  return (result[key] as PendingDraft[] | undefined) ?? [];
}

export async function saveDrafts(ref: PrRef, drafts: PendingDraft[]): Promise<void> {
  await browser.storage.local.set({ [draftsKey(ref)]: drafts });
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
   * hunks can be recomputed for any file — not only the one open in the editor. */
  base: string;
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

/** author's accept/reject decision on submitted suggestions, keyed by GitHub comment id. */
export type SuggestionDecision = "accepted" | "rejected";

function dismissedKey(ref: PrRef): string {
  return `${storageKeys.pr(ref.owner, ref.repo, ref.number)}:dismissed-suggestions`;
}

export async function listDismissedSuggestions(
  ref: PrRef,
): Promise<Record<string, SuggestionDecision>> {
  const key = dismissedKey(ref);
  const result = await browser.storage.local.get(key);
  return (result[key] as Record<string, SuggestionDecision> | undefined) ?? {};
}

export async function saveDismissedSuggestions(
  ref: PrRef,
  decisions: Record<string, SuggestionDecision>,
): Promise<void> {
  await browser.storage.local.set({ [dismissedKey(ref)]: decisions });
}

/**
 * Discard every pending review item for a PR: the reviewer's comment/suggestion
 * drafts and their in-progress suggestion edits. The author's accept/reject
 * decisions (dismissed suggestions) are deliberately left intact — they reflect
 * already-submitted suggestions, not pending review state.
 */
export async function discardAllDrafts(ref: PrRef): Promise<void> {
  await Promise.all([saveDrafts(ref, []), saveSuggestionEdits(ref, {})]);
}
