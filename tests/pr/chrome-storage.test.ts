import { describe, expect, test } from "bun:test";
import {
  BrowserStorageAdapter,
  type BrowserStorageAPI,
  evictStalePrStorage,
  prStorageKey,
  prStorageKeys,
} from "../../lib/pr/chrome-storage";
import type { LocalState } from "../../lib/pr/types";
import { emptyState } from "../../lib/pr/types";
import { storageKeys } from "../../lib/storage";

/** In-memory fake of the chrome.storage.local subset we use. */
function fakeBrowserStorage(): BrowserStorageAPI {
  const store: Record<string, unknown> = {};
  return {
    async get(key: string | null) {
      if (key === null) return { ...store };
      return key in store ? { [key]: store[key] } : {};
    },
    async set(items: Record<string, unknown>) {
      Object.assign(store, items);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
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

  test("shares its prefix with the keys lib/drafts.ts builds", () => {
    expect(prStorageKey("acme", "site", 42)).toBe(`${storageKeys.pr("acme", "site", 42)}:state`);
  });

  test("prStorageKeys lists every key a PR occupies, on the same prefix", () => {
    expect(prStorageKeys("acme", "site", 42)).toEqual([
      "pr:acme/site#42:state",
      "pr:acme/site#42:suggestion-edits",
      "pr:acme/site#42:dismissed-suggestions",
    ]);
  });
});

describe("chrome-storage — evictStalePrStorage (issue #289)", () => {
  const comment = (state: string) => ({
    id: "c1",
    state,
    threadId: "t1",
    body: "b",
    author: { login: "alice" },
    path: "f.md",
    anchor: { sha: "h", range: { sl: 1, sc: 1, el: 1, ec: 2 }, quote: "h" },
  });

  function stateWith(over: Partial<Record<string, unknown[]>>) {
    return { ...emptyState(), ...over };
  }

  /** The PR under review in these cases: `pr:o/r#2`, open unless said otherwise. */
  const current = (merged = false) => ({
    key: prStorageKey("o", "r", 2),
    merged,
    keys: prStorageKeys("o", "r", 2),
  });

  test("removes the persisted state of another PR that holds no draft or syncing entity", async () => {
    const storage = fakeBrowserStorage();
    await storage.set({
      "pr:o/r#1:state": stateWith({ comments: [comment("synced")] }),
      "pr:o/r#1:suggestion-edits": { "a.md": { source: "x", base: "y", comments: {} } },
      [current().key]: stateWith({}),
    });

    expect(await evictStalePrStorage(storage, current())).toEqual(["pr:o/r#1:state"]);
    expect(await storage.get("pr:o/r#1:state")).toEqual({});
    // Suggestion edits are the reviewer's own work, not a mirror of GitHub.
    expect(await storage.get("pr:o/r#1:suggestion-edits")).toEqual({
      "pr:o/r#1:suggestion-edits": { "a.md": { source: "x", base: "y", comments: {} } },
    });
  });

  test("keeps another PR's state while it holds a draft", async () => {
    const storage = fakeBrowserStorage();
    await storage.set({ "pr:o/r#1:state": stateWith({ comments: [comment("draft")] }) });

    expect(await evictStalePrStorage(storage, current())).toEqual([]);
    expect(await storage.get("pr:o/r#1:state")).not.toEqual({});
  });

  test("keeps another PR's state while it holds a syncing fileEdit", async () => {
    const storage = fakeBrowserStorage();
    await storage.set({
      "pr:o/r#1:state": stateWith({
        fileEdits: [{ path: "f.md", state: "syncing", editedSource: "x" }],
      }),
    });

    expect(await evictStalePrStorage(storage, current())).toEqual([]);
    expect(await storage.get("pr:o/r#1:state")).not.toEqual({});
  });

  test("never touches the current PR while it is open", async () => {
    const storage = fakeBrowserStorage();
    await storage.set({ [current().key]: stateWith({ comments: [comment("synced")] }) });

    expect(await evictStalePrStorage(storage, current())).toEqual([]);
    expect(await storage.get(current().key)).not.toEqual({});
  });

  test("removes all three keys of the current PR once it is merged", async () => {
    const storage = fakeBrowserStorage();
    const [stateKey, editsKey, dismissedKey] = prStorageKeys("o", "r", 2) as [
      string,
      string,
      string,
    ];
    await storage.set({
      [stateKey]: stateWith({ comments: [comment("draft")] }),
      [editsKey]: { "a.md": { source: "x", base: "y", comments: {} } },
      [dismissedKey]: { "1": "accepted" },
    });

    const removed = await evictStalePrStorage(storage, current(true));

    expect(removed.sort()).toEqual([stateKey, editsKey, dismissedKey].sort());
    expect(await storage.get(stateKey)).toEqual({});
    expect(await storage.get(editsKey)).toEqual({});
    expect(await storage.get(dismissedKey)).toEqual({});
  });

  test("removes an unparseable pr state value", async () => {
    const storage = fakeBrowserStorage();
    await storage.set({ "pr:o/r#1:state": "garbage" });

    expect(await evictStalePrStorage(storage, current())).toEqual(["pr:o/r#1:state"]);
    expect(await storage.get("pr:o/r#1:state")).toEqual({});
  });

  test("ignores keys that are not a PR state", async () => {
    const storage = fakeBrowserStorage();
    await storage.set({ github_token: "t", "pr:o/r#1:suggestion-edits": {} });

    expect(await evictStalePrStorage(storage, current())).toEqual([]);
    expect(await storage.get("github_token")).toEqual({ github_token: "t" });
  });
});
