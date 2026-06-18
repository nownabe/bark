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

const { listSuggestionEdits, saveSuggestionEdits } = await import("../lib/drafts");

const ref = { owner: "o", repo: "r", number: 1 };

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe("suggestion-edit persistence", () => {
  test("returns an empty map when nothing is stored", async () => {
    expect(await listSuggestionEdits(ref)).toEqual({});
  });

  test("round-trips edited source and per-suggestion comments by path", async () => {
    await saveSuggestionEdits(ref, {
      "docs/a.md": { source: "edited A", comments: { "live:2:2": "why this change" } },
      "docs/b.md": { source: "edited B", comments: {} },
    });
    expect(await listSuggestionEdits(ref)).toEqual({
      "docs/a.md": { source: "edited A", comments: { "live:2:2": "why this change" } },
      "docs/b.md": { source: "edited B", comments: {} },
    });
  });

  test("is scoped per PR", async () => {
    await saveSuggestionEdits(ref, { "a.md": { source: "x", comments: {} } });
    expect(await listSuggestionEdits({ owner: "o", repo: "r", number: 2 })).toEqual({});
  });
});
