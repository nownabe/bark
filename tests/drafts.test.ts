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
  listDrafts,
  saveDrafts,
  listSuggestionEdits,
  saveSuggestionEdits,
  listDismissedSuggestions,
  saveDismissedSuggestions,
  discardAllDrafts,
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

describe("discardAllDrafts", () => {
  const draft = {
    cid: "d1",
    path: "a.md",
    inDiff: true,
    range: { sl: 1, sc: 1, el: 1, ec: 5 },
    quote: "q",
    sha: "sha",
    thread: "d1",
    body: "body",
    kind: "comment" as const,
  };

  test("clears every pending comment draft and suggestion edit", async () => {
    await saveDrafts(ref, [draft]);
    await saveSuggestionEdits(ref, { "a.md": { source: "x", base: "x0", comments: {} } });

    await discardAllDrafts(ref);

    expect(await listDrafts(ref)).toEqual([]);
    expect(await listSuggestionEdits(ref)).toEqual({});
  });

  test("preserves the author's accept/reject decisions (not pending review state)", async () => {
    await saveDrafts(ref, [draft]);
    await saveDismissedSuggestions(ref, { "123": "accepted" });

    await discardAllDrafts(ref);

    expect(await listDismissedSuggestions(ref)).toEqual({ "123": "accepted" });
  });

  test("only discards the given PR's drafts", async () => {
    const other = { owner: "o", repo: "r", number: 2 };
    await saveDrafts(ref, [draft]);
    await saveDrafts(other, [draft]);

    await discardAllDrafts(ref);

    expect(await listDrafts(ref)).toEqual([]);
    expect(await listDrafts(other)).toEqual([draft]);
  });
});
