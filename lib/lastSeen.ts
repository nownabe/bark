// Per-viewer, per-PR "last-seen head SHA" for R10 baseline selection (§7.10).
//
// The default redline baseline is the head SHA the viewer last looked at this
// PR — a purely local, per-viewer preference, so it lives in chrome.storage
// (not LocalState, which is reserved for GitHub-round-tripped entities — ADR
// 0002 §2). Same storage-adapter conventions as lib/drafts.ts: browser.storage
// .local keyed per PR via storageKeys.pr().
import { browser } from "wxt/browser";
import type { PrRef } from "./github";
import { storageKeys } from "./storage";

export interface LastSeen {
  /** The head SHA the viewer last saw for this PR. */
  sha: string;
  /** Epoch millis of that visit. */
  seenAt: number;
}

function lastSeenKey(ref: PrRef): string {
  return `${storageKeys.pr(ref.owner, ref.repo, ref.number)}:last-seen`;
}

/** The viewer's last-seen head SHA for this PR, or null on the first visit. */
export async function readLastSeen(ref: PrRef): Promise<LastSeen | null> {
  const key = lastSeenKey(ref);
  const result = await browser.storage.local.get(key);
  return (result[key] as LastSeen | undefined) ?? null;
}

/** Record `sha` as the viewer's last-seen head SHA for this PR (stamps now). */
export async function writeLastSeen(ref: PrRef, sha: string): Promise<void> {
  await browser.storage.local.set({ [lastSeenKey(ref)]: { sha, seenAt: Date.now() } });
}

/**
 * Return the previously stored last-seen SHA (the redline baseline) and advance
 * the stored value to `headSha` — atomically, from the caller's perspective.
 *
 * The consume-then-advance ordering is correctness-critical: the prior SHA must
 * be captured BEFORE it is overwritten, otherwise the baseline is lost and the
 * redline compares head against itself. Returns:
 *  - null on the first view (nothing stored yet) — still records `headSha`.
 *  - the prior SHA when the head has advanced — and stores `headSha`.
 *  - `headSha` unchanged when it equals the stored SHA, writing nothing (no
 *    churn); the caller treats baseline === head as "no redline".
 */
export async function consumeAndAdvanceBaseline(
  ref: PrRef,
  headSha: string,
): Promise<string | null> {
  const prior = await readLastSeen(ref);
  if (prior?.sha === headSha) return headSha; // no advance, no write
  await writeLastSeen(ref, headSha);
  return prior?.sha ?? null;
}
