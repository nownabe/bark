// Browser-storage-backed StorageAdapter for the extension.
// Persists LocalState under a single key in chrome.storage.local.
//
// The class takes the storage API as a constructor argument so it stays
// unit-testable (no `browser` global needed in tests).

import type { StorageAdapter } from "./storage";
import type { LocalState } from "./types";

export interface BrowserStorageAPI {
  /** `null` lists every stored item (used by eviction). */
  get(key: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export class BrowserStorageAdapter implements StorageAdapter {
  constructor(
    private readonly key: string,
    private readonly storage: BrowserStorageAPI,
  ) {}

  async load(): Promise<LocalState | null> {
    const result = await this.storage.get(this.key);
    return (result[this.key] as LocalState | undefined) ?? null;
  }

  async save(state: LocalState): Promise<void> {
    await this.storage.set({ [this.key]: state });
  }
}

/** Conventional storage key for a PR's LocalState. */
export function prStorageKey(owner: string, repo: string, number: number): string {
  return `pr:${owner}/${repo}#${number}:state`;
}

const PR_KEY_SUFFIXES = [":state", ":suggestion-edits", ":dismissed-suggestions"] as const;

/** Every key one PR occupies, built on the same prefix as `prStorageKey` so
 *  eviction and `lib/drafts.ts` cannot drift apart. */
export function prStorageKeys(owner: string, repo: string, number: number): string[] {
  const prefix = prStorageKey(owner, repo, number).replace(/:state$/, "");
  return PR_KEY_SUFFIXES.map((suffix) => `${prefix}${suffix}`);
}

/** False for a value that cannot be hydrated either: such a state is dead
 *  weight, so eviction treats it the same as a work-free mirror. */
function hasLocalWork(value: unknown): boolean {
  const state = value as LocalState | undefined;
  return [state?.comments, state?.threads, state?.fileEdits].some(
    (entities) => Array.isArray(entities) && entities.some((e) => e.state !== "synced"),
  );
}

/**
 * Drop persisted state that can no longer be used, so `chrome.storage.local`
 * stays bounded by the PRs that still carry unsubmitted work (ADR 0001 §2).
 *
 * The synced part of a `LocalState` is a first-paint cache of GitHub, not user
 * data, and only the PR being opened can still paint from it — so every *other*
 * PR's mirror goes unless it holds a `draft`/`syncing` entity. The current PR
 * keeps everything until it is merged, at which point all of its keys go:
 * nothing stored against a merged PR's branch can still be submitted.
 * Returns the keys removed.
 */
export async function evictStalePrStorage(
  storage: BrowserStorageAPI,
  current: { key: string; merged: boolean; keys: string[] },
): Promise<string[]> {
  const all = await storage.get(null);
  const stale = Object.keys(all).filter(
    (key) =>
      key.startsWith("pr:") &&
      key.endsWith(":state") &&
      key !== current.key &&
      !hasLocalWork(all[key]),
  );
  if (current.merged) stale.push(...current.keys.filter((key) => key in all));
  if (stale.length > 0) await storage.remove(stale);
  return stale;
}
