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
