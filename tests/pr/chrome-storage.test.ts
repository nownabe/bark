import { describe, expect, test } from "bun:test";
import {
  BrowserStorageAdapter,
  type BrowserStorageAPI,
  prStorageKey,
} from "../../lib/pr/chrome-storage";
import type { LocalState } from "../../lib/pr/types";
import { emptyState } from "../../lib/pr/types";

/** In-memory fake of the chrome.storage.local subset we use. */
function fakeBrowserStorage(): BrowserStorageAPI {
  const store: Record<string, unknown> = {};
  return {
    async get(key: string) {
      return key in store ? { [key]: store[key] } : {};
    },
    async set(items: Record<string, unknown>) {
      Object.assign(store, items);
    },
    async remove(key: string) {
      delete store[key];
    },
  };
}

describe("chrome-storage — BrowserStorageAdapter", () => {
  test("load() returns null when nothing has been saved", async () => {
    const adapter = new BrowserStorageAdapter("k", fakeBrowserStorage());
    expect(await adapter.load()).toBeNull();
  });

  test("save() then load() round-trips a LocalState", async () => {
    const adapter = new BrowserStorageAdapter("k", fakeBrowserStorage());
    const state: LocalState = {
      ...emptyState(),
      comments: [
        {
          id: "c1",
          state: "draft",
          threadId: "t1",
          body: "hi",
          author: { login: "alice" },
          path: "f.md",
          anchor: {
            sha: "h",
            range: { sl: 1, sc: 1, el: 1, ec: 2 },
            quote: "h",
          },
        },
      ],
    };
    await adapter.save(state);
    expect(await adapter.load()).toEqual(state);
  });

  test("different keys do not collide", async () => {
    const storage = fakeBrowserStorage();
    const a = new BrowserStorageAdapter("k1", storage);
    const b = new BrowserStorageAdapter("k2", storage);
    await a.save({ ...emptyState(), comments: [] });
    await b.save({ ...emptyState() });
    // Set distinct values to verify isolation.
    const stateA: LocalState = { ...emptyState(), fileEdits: [] };
    await a.save(stateA);
    expect(await a.load()).toEqual(stateA);
    expect(await b.load()).toEqual(emptyState());
  });
});

describe("chrome-storage — prStorageKey", () => {
  test("constructs a key with owner / repo / number", () => {
    expect(prStorageKey("acme", "site", 42)).toBe("pr:acme/site#42:state");
  });

  test("keys for different PRs differ", () => {
    expect(prStorageKey("a", "b", 1)).not.toBe(prStorageKey("a", "b", 2));
    expect(prStorageKey("a", "b", 1)).not.toBe(prStorageKey("a", "c", 1));
  });
});
