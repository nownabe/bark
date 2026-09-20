import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  type DismissedDeps,
  useDismissedSuggestions,
} from "../entrypoints/review/hooks/useDismissedSuggestions";
import type { SuggestionDecision } from "../lib/drafts";
import type { PrRef } from "../lib/github";

afterEach(() => {
  cleanup();
});

const PR: PrRef = { owner: "o", repo: "r", number: 7 };

function makeDeps(overrides: Partial<DismissedDeps> = {}): DismissedDeps {
  return {
    listDismissedSuggestions: mock(async () => ({})),
    saveDismissedSuggestions: mock(async () => {}),
    ...overrides,
  };
}

describe("useDismissedSuggestions — restore", () => {
  test("with no ref: state stays empty and listDismissedSuggestions is not called", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useDismissedSuggestions(null, deps));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.dismissed).toEqual({});
    expect(deps.listDismissedSuggestions).not.toHaveBeenCalled();
  });

  test("with a ref: listDismissedSuggestions is called and the result lands in state", async () => {
    const stored: Record<string, SuggestionDecision> = {
      "1": "accepted",
      "2": "accepted",
    };
    const deps = makeDeps({ listDismissedSuggestions: mock(async () => stored) });
    const { result } = renderHook(() => useDismissedSuggestions(PR, deps));
    await waitFor(() => {
      expect(result.current.dismissed["1"]).toBe("accepted");
    });
    expect(result.current.dismissed["2"]).toBe("accepted");
  });
});

describe("useDismissedSuggestions — setDecision", () => {
  test("updates state and persists atomically", async () => {
    const saveDismissedSuggestions = mock(
      async (_r: PrRef, _d: Record<string, SuggestionDecision>) => {},
    );
    const deps = makeDeps({ saveDismissedSuggestions });
    const { result } = renderHook(() => useDismissedSuggestions(PR, deps));
    await waitFor(() => expect(deps.listDismissedSuggestions).toHaveBeenCalled());

    await act(async () => {
      await result.current.setDecision(42, "accepted");
    });
    expect(result.current.dismissed["42"]).toBe("accepted");
    expect(saveDismissedSuggestions).toHaveBeenCalledWith(PR, { "42": "accepted" });
  });

  test("without a ref: updates state, does NOT call saveDismissedSuggestions", async () => {
    const saveDismissedSuggestions = mock(async () => {});
    const deps = makeDeps({ saveDismissedSuggestions });
    const { result } = renderHook(() => useDismissedSuggestions(null, deps));

    await act(async () => {
      await result.current.setDecision(7, "accepted");
    });
    expect(result.current.dismissed["7"]).toBe("accepted");
    expect(saveDismissedSuggestions).not.toHaveBeenCalled();
  });
});

describe("useDismissedSuggestions — reset", () => {
  test("clears local state without touching storage", async () => {
    const saveDismissedSuggestions = mock(async () => {});
    const deps = makeDeps({
      listDismissedSuggestions: mock(async (): Promise<Record<string, SuggestionDecision>> => ({
        "1": "accepted",
      })),
      saveDismissedSuggestions,
    });
    const { result } = renderHook(() => useDismissedSuggestions(PR, deps));
    await waitFor(() => expect(result.current.dismissed["1"]).toBe("accepted"));

    act(() => {
      result.current.reset();
    });
    expect(result.current.dismissed).toEqual({});
    expect(saveDismissedSuggestions).not.toHaveBeenCalled();
  });
});
