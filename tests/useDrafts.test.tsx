import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type DraftsDeps, useDrafts } from "../entrypoints/review/hooks/useDrafts";
import type { PendingDraft } from "../lib/drafts";
import type { PrRef } from "../lib/github";

afterEach(() => {
  cleanup();
});

const PR: PrRef = { owner: "o", repo: "r", number: 7 };

function makeDraft(overrides: Partial<PendingDraft> = {}): PendingDraft {
  return {
    cid: "draft-1",
    path: "f.md",
    kind: "comment",
    body: "body",
    quote: "hello",
    range: { sl: 1, sc: 1, el: 1, ec: 5 },
    ...overrides,
  } as PendingDraft;
}

function makeDeps(overrides: Partial<DraftsDeps> = {}): DraftsDeps {
  return {
    listDrafts: mock(async () => []),
    saveDrafts: mock(async () => {}),
    ...overrides,
  };
}

describe("useDrafts — initial restore", () => {
  test("with no PR ref, drafts stay []", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useDrafts(null, deps));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.drafts).toEqual([]);
    expect(deps.listDrafts).not.toHaveBeenCalled();
  });

  test("with a PR ref, listDrafts is called and the result lands in state", async () => {
    const stored = [makeDraft({ cid: "stored-1" }), makeDraft({ cid: "stored-2" })];
    const deps = makeDeps({ listDrafts: mock(async () => stored) });
    const { result } = renderHook(() => useDrafts(PR, deps));
    await waitFor(() => {
      expect(result.current.drafts).toHaveLength(2);
    });
    expect(result.current.drafts.map((d) => d.cid)).toEqual(["stored-1", "stored-2"]);
    expect(deps.listDrafts).toHaveBeenCalledWith(PR);
  });
});

describe("useDrafts — replaceAndPersist", () => {
  test("updates state and writes to storage atomically", async () => {
    const saveDrafts = mock(async (_r: PrRef, _d: PendingDraft[]) => {});
    const deps = makeDeps({ saveDrafts });
    const { result } = renderHook(() => useDrafts(PR, deps));
    // Wait for the initial restore to settle so it can't race with the write.
    await waitFor(() => expect(deps.listDrafts).toHaveBeenCalled());

    const next = [makeDraft({ cid: "new-1" })];
    await act(async () => {
      await result.current.replaceAndPersist(next);
    });
    expect(result.current.drafts.map((d) => d.cid)).toEqual(["new-1"]);
    expect(saveDrafts).toHaveBeenCalledWith(PR, next);
  });

  test("without a PR ref, updates state but does NOT call saveDrafts", async () => {
    const saveDrafts = mock(async () => {});
    const deps = makeDeps({ saveDrafts });
    const { result } = renderHook(() => useDrafts(null, deps));

    const next = [makeDraft()];
    await act(async () => {
      await result.current.replaceAndPersist(next);
    });
    expect(result.current.drafts).toEqual(next);
    expect(saveDrafts).not.toHaveBeenCalled();
  });
});

describe("useDrafts — reset", () => {
  test("clears local state without calling saveDrafts", async () => {
    const stored = [makeDraft()];
    const saveDrafts = mock(async () => {});
    const deps = makeDeps({ listDrafts: mock(async () => stored), saveDrafts });
    const { result } = renderHook(() => useDrafts(PR, deps));
    await waitFor(() => expect(result.current.drafts).toHaveLength(1));

    act(() => {
      result.current.reset();
    });
    expect(result.current.drafts).toEqual([]);
    expect(saveDrafts).not.toHaveBeenCalled();
  });
});
