// Browser-storage-backed StorageAdapter for the extension.
// Persists LocalState under a single key in chrome.storage.local.
//
// The class takes the storage API as a constructor argument so it stays
// unit-testable (no `browser` global needed in tests).

import type { StorageAdapter } from "./storage";
import type { LocalState } from "./types";

export interface BrowserStorageAPI {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
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
