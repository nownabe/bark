import { beforeEach, describe, expect, mock, test } from "bun:test";

// Drafts/suggestion-edit storage is a thin wrapper over chrome.storage.local;
// back it with an in-memory store so the round-trip can be exercised.
const store: Record<string, unknown> = {};
mock.module("wxt/browser", () => ({
  browser: {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        },
        remove: async (key: string) => {
          delete store[key];
        },
      },
    },
  },
}));

const {
  listSuggestionEdits,
  saveSuggestionEdits,
  listDismissedSuggestions,
  saveDismissedSuggestions,
  clearAcceptedDecisions,
} = await import("../lib/drafts");

const ref = { owner: "o", repo: "r", number: 1 };

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe("suggestion-edit persistence", () => {
  test("returns an empty map when nothing is stored", async () => {
    expect(await listSuggestionEdits(ref)).toEqual({});
  });

  test("round-trips edited source, base, and per-suggestion comments by path", async () => {
    await saveSuggestionEdits(ref, {
      "docs/a.md": {
        source: "edited A",
        base: "base A",
        comments: { "live:2:2": "why this change" },
      },
      "docs/b.md": { source: "edited B", base: "base B", comments: {} },
    });
    expect(await listSuggestionEdits(ref)).toEqual({
      "docs/a.md": {
        source: "edited A",
        base: "base A",
        comments: { "live:2:2": "why this change" },
      },
      "docs/b.md": { source: "edited B", base: "base B", comments: {} },
    });
  });

  test("is scoped per PR", async () => {
    await saveSuggestionEdits(ref, { "a.md": { source: "x", base: "x0", comments: {} } });
    expect(await listSuggestionEdits({ owner: "o", repo: "r", number: 2 })).toEqual({});
  });
});

describe("clearAcceptedDecisions", () => {
  test("removes only 'accepted' entries whose id is in the given list", async () => {
    await saveDismissedSuggestions(ref, {
      "1": "accepted",
      "2": "accepted",
      "3": "rejected",
    });
    await clearAcceptedDecisions(ref, [1, 2]);
    expect(await listDismissedSuggestions(ref)).toEqual({ "3": "rejected" });
  });

  test("leaves 'rejected' entries alone even when their id is in the list", async () => {
    await saveDismissedSuggestions(ref, { "1": "rejected" });
    await clearAcceptedDecisions(ref, [1]);
    expect(await listDismissedSuggestions(ref)).toEqual({ "1": "rejected" });
  });

  test("only removes the requested ids — other 'accepted' entries stay", async () => {
    await saveDismissedSuggestions(ref, {
      "1": "accepted",
      "2": "accepted",
    });
    await clearAcceptedDecisions(ref, [1]);
    expect(await listDismissedSuggestions(ref)).toEqual({ "2": "accepted" });
  });

  test("is idempotent on missing ids (no throw, no change)", async () => {
    await saveDismissedSuggestions(ref, { "1": "accepted" });
    await clearAcceptedDecisions(ref, [99]);
    expect(await listDismissedSuggestions(ref)).toEqual({ "1": "accepted" });
  });

  test("handles an empty store gracefully", async () => {
    await clearAcceptedDecisions(ref, [1, 2, 3]);
    expect(await listDismissedSuggestions(ref)).toEqual({});
  });
});
