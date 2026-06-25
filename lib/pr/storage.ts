// Storage adapter — the persistence boundary for LocalState.
// The Repository depends on this interface; concrete implementations
// (in-memory for tests, chrome.storage for the extension) live elsewhere.
//
// See docs/adr/0001-pr-data-layer-architecture.md §1.

import type { LocalState } from "./types";

export interface StorageAdapter {
  load(): Promise<LocalState | null>;
  save(state: LocalState): Promise<void>;
}

/** In-memory adapter, useful for tests and as a default. */
export class InMemoryStorageAdapter implements StorageAdapter {
  private value: LocalState | null = null;

  async load(): Promise<LocalState | null> {
    return this.value;
  }

  async save(state: LocalState): Promise<void> {
    this.value = state;
  }
}
