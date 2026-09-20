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
type SuggestionDecision = import("../lib/drafts").SuggestionDecision;

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

describe("listDismissedSuggestions (issue #287)", () => {
  test("drops legacy 'rejected' entries", async () => {
    // An earlier build stored rejections here; rejection is now a resolved
    // thread on GitHub, so a stale local entry must not hide a suggestion
    // forever. The cast writes a value the type no longer admits.
    await saveDismissedSuggestions(ref, { "1": "accepted", "2": "rejected" } as unknown as Record<
      string,
      SuggestionDecision
    >);
    expect(await listDismissedSuggestions(ref)).toEqual({ "1": "accepted" });
  });
});

describe("clearAcceptedDecisions", () => {
  test("removes only the entries whose id is in the given list", async () => {
    await saveDismissedSuggestions(ref, {
      "1": "accepted",
      "2": "accepted",
      "3": "accepted",
    });
    await clearAcceptedDecisions(ref, [1, 2]);
    expect(await listDismissedSuggestions(ref)).toEqual({ "3": "accepted" });
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
