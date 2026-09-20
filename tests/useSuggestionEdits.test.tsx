import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  type SuggestionEditsDeps,
  useSuggestionEdits,
} from "../entrypoints/review/hooks/useSuggestionEdits";
import type { SuggestionEdit } from "../lib/drafts";
import type { PrRef } from "../lib/pr/types";

afterEach(() => {
  cleanup();
});

const PR: PrRef = { owner: "o", repo: "r", number: 7 };

function makeEdit(overrides: Partial<SuggestionEdit> = {}): SuggestionEdit {
  return {
    source: "edited",
    base: "original",
    comments: {},
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SuggestionEditsDeps> = {}): SuggestionEditsDeps {
  return {
    listSuggestionEdits: mock(async () => ({})),
    saveSuggestionEdits: mock(async () => {}),
    ...overrides,
  };
}

describe("useSuggestionEdits — restore", () => {
  test("with no ref: state stays empty and listSuggestionEdits is not called", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useSuggestionEdits(null, deps));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.suggestionEdits).toEqual({});
    expect(deps.listSuggestionEdits).not.toHaveBeenCalled();
  });

  test("with a ref: listSuggestionEdits is called and its result reaches state", async () => {
    const stored: Record<string, SuggestionEdit> = {
      "a.md": makeEdit({ source: "A2" }),
      "b.md": makeEdit({ source: "B2" }),
    };
    const deps = makeDeps({ listSuggestionEdits: mock(async () => stored) });
    const { result } = renderHook(() => useSuggestionEdits(PR, deps));
    await waitFor(() => {
      expect(Object.keys(result.current.suggestionEdits).sort()).toEqual(["a.md", "b.md"]);
    });
    expect(result.current.suggestionEdits["a.md"]?.source).toBe("A2");
  });
});

describe("useSuggestionEdits — persistSuggestionEdit", () => {
  test("when src differs from base, the path's edit is added to in-memory state immediately", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useSuggestionEdits(PR, deps));
    await waitFor(() => expect(deps.listSuggestionEdits).toHaveBeenCalled());

    act(() => {
      result.current.persistSuggestionEdit("a.md", "EDITED", "ORIGINAL", { "c-1": "x" });
    });
    expect(result.current.suggestionEdits["a.md"]).toEqual({
      source: "EDITED",
      base: "ORIGINAL",
      comments: { "c-1": "x" },
    });
  });

  test("when src equals base, the path is removed from in-memory state", async () => {
    const deps = makeDeps({
      listSuggestionEdits: mock(async () => ({
        "a.md": makeEdit({ source: "still-edited" }),
      })),
    });
    const { result } = renderHook(() => useSuggestionEdits(PR, deps));
    await waitFor(() => expect(result.current.suggestionEdits["a.md"]).toBeDefined());

    act(() => {
      result.current.persistSuggestionEdit("a.md", "same", "same", {});
    });
    expect("a.md" in result.current.suggestionEdits).toBe(false);
  });
});

describe("useSuggestionEdits — flushPendingWrites", () => {
  test("read-modify-writes the per-path edit to storage (preserves untouched paths)", async () => {
    const saveSuggestionEdits = mock(async (_r: PrRef, _e: Record<string, SuggestionEdit>) => {});
    const listSuggestionEdits = mock(async () => ({
      "untouched.md": makeEdit({ source: "leave-me" }),
    }));
    const deps = makeDeps({ listSuggestionEdits, saveSuggestionEdits });
    const { result } = renderHook(() => useSuggestionEdits(PR, deps));
    await waitFor(() => expect(result.current.suggestionEdits["untouched.md"]).toBeDefined());

    act(() => {
      result.current.persistSuggestionEdit("a.md", "EDITED", "ORIGINAL", {});
    });
    await act(async () => {
      await result.current.flushPendingWrites();
    });
    expect(saveSuggestionEdits).toHaveBeenCalledTimes(1);
    const written = (saveSuggestionEdits.mock.calls[0] as unknown[])[1] as Record<
      string,
      SuggestionEdit
    >;
    // The other tab's untouched path survives the merge; the new edit lands.
    expect(written["untouched.md"]?.source).toBe("leave-me");
    expect(written["a.md"]?.source).toBe("EDITED");
  });

  test("a failed flush reports through onSaveError and retries on the next flush (#289)", async () => {
    let failed = false;
    const saveSuggestionEdits = mock(async (_r: PrRef, _e: Record<string, SuggestionEdit>) => {
      if (failed) return;
      failed = true;
      throw new Error("QUOTA_BYTES quota exceeded");
    });
    const onSaveError = mock((_e: unknown) => {});
    const deps = makeDeps({ saveSuggestionEdits, onSaveError });
    const { result } = renderHook(() => useSuggestionEdits(PR, deps));
    await waitFor(() => expect(deps.listSuggestionEdits).toHaveBeenCalled());

    act(() => {
      result.current.persistSuggestionEdit("a.md", "EDITED", "ORIGINAL", {});
    });
    await act(async () => {
      await result.current.flushPendingWrites();
    });
    expect(onSaveError).toHaveBeenCalledTimes(1);

    // The un-flushed write went back into the buffer, so the next flush retries it.
    await act(async () => {
      await result.current.flushPendingWrites();
    });
    expect(saveSuggestionEdits).toHaveBeenCalledTimes(2);
    const written = (saveSuggestionEdits.mock.calls[1] as unknown[])[1] as Record<
      string,
      SuggestionEdit
    >;
    expect(written["a.md"]?.source).toBe("EDITED");
  });

  test("with no pending writes, saveSuggestionEdits is not called", async () => {
    const saveSuggestionEdits = mock(async () => {});
    const deps = makeDeps({ saveSuggestionEdits });
    const { result } = renderHook(() => useSuggestionEdits(PR, deps));
    await waitFor(() => expect(deps.listSuggestionEdits).toHaveBeenCalled());

    await act(async () => {
      await result.current.flushPendingWrites();
    });
    expect(saveSuggestionEdits).not.toHaveBeenCalled();
  });
});

describe("useSuggestionEdits — discardAllPersisted", () => {
  test("wipes state AND writes an empty map to storage", async () => {
    const saveSuggestionEdits = mock(async () => {});
    const deps = makeDeps({
      listSuggestionEdits: mock(async () => ({ "a.md": makeEdit() })),
      saveSuggestionEdits,
    });
    const { result } = renderHook(() => useSuggestionEdits(PR, deps));
    await waitFor(() => expect(result.current.suggestionEdits["a.md"]).toBeDefined());

    await act(async () => {
      await result.current.discardAllPersisted();
    });
    expect(result.current.suggestionEdits).toEqual({});
    expect(saveSuggestionEdits).toHaveBeenCalledWith(PR, {});
  });
});

describe("useSuggestionEdits — reset", () => {
  test("clears in-memory state without touching storage", async () => {
    const saveSuggestionEdits = mock(async () => {});
    const deps = makeDeps({
      listSuggestionEdits: mock(async () => ({ "a.md": makeEdit() })),
      saveSuggestionEdits,
    });
    const { result } = renderHook(() => useSuggestionEdits(PR, deps));
    await waitFor(() => expect(result.current.suggestionEdits["a.md"]).toBeDefined());

    act(() => {
      result.current.setSuggestionComments({ "c-1": "hi" });
    });
    expect(result.current.suggestionComments["c-1"]).toBe("hi");

    act(() => {
      result.current.reset();
    });
    expect(result.current.suggestionEdits).toEqual({});
    expect(result.current.suggestionComments).toEqual({});
    expect(saveSuggestionEdits).not.toHaveBeenCalled();
  });
});
