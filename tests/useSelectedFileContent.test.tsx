import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  type SelectedFileContentCallbacks,
  type SelectedFileContentClient,
  type SelectedFileContentDeps,
  useSelectedFileContent,
} from "../entrypoints/review/hooks/useSelectedFileContent";
import type { SuggestionEdit } from "../lib/drafts";
import type { PrRef } from "../lib/github";

afterEach(() => {
  cleanup();
});

const PR: PrRef = { owner: "o", repo: "r", number: 7 };

function makeClient(overrides: Partial<SelectedFileContentClient> = {}): SelectedFileContentClient {
  return {
    getFileContent: mock(async () => "FETCHED"),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SelectedFileContentDeps> = {}): SelectedFileContentDeps {
  return {
    listSuggestionEdits: mock(async () => ({})),
    ...overrides,
  };
}

function makeCallbacks(
  overrides: Partial<SelectedFileContentCallbacks> = {},
): SelectedFileContentCallbacks {
  return {
    onLoadingChange: mock((_l: boolean) => {}),
    onError: mock((_m: string) => {}),
    onLoaded: mock((_info: { path: string; text: string; edit: SuggestionEdit | undefined }) => {}),
    onCleanup: mock(() => {}),
    ...overrides,
  };
}

describe("useSelectedFileContent — gating", () => {
  test("does nothing while client / ref / headSha / selectedPath is null", async () => {
    const client = makeClient();
    const deps = makeDeps();
    const callbacks = makeCallbacks();

    renderHook(() => useSelectedFileContent(null, PR, "h", "f.md", "", deps, callbacks));
    renderHook(() => useSelectedFileContent(client, null, "h", "f.md", "", deps, callbacks));
    renderHook(() => useSelectedFileContent(client, PR, null, "f.md", "", deps, callbacks));
    renderHook(() => useSelectedFileContent(client, PR, "h", null, "", deps, callbacks));

    await new Promise((r) => setTimeout(r, 10));
    expect(client.getFileContent).not.toHaveBeenCalled();
    expect(deps.listSuggestionEdits).not.toHaveBeenCalled();
    expect(callbacks.onLoadingChange).not.toHaveBeenCalled();
  });
});

describe("useSelectedFileContent — happy path", () => {
  test("fetches file content, restores per-path edit, drives source/baseSource and onLoaded", async () => {
    const edit: SuggestionEdit = {
      source: "PERSISTED",
      base: "FETCHED",
      comments: { "c-1": "hi" },
    };
    const client = makeClient({ getFileContent: mock(async () => "FETCHED") });
    const deps = makeDeps({
      listSuggestionEdits: mock(async () => ({ "f.md": edit })),
    });
    const callbacks = makeCallbacks();
    const { result } = renderHook(() =>
      useSelectedFileContent(client, PR, "h", "f.md", "", deps, callbacks),
    );

    await waitFor(() => expect(result.current.baseSource).toBe("FETCHED"));
    // source picks up the persisted edit's source (so editing survives reload).
    expect(result.current.source).toBe("PERSISTED");
    expect(callbacks.onLoaded).toHaveBeenCalledWith({
      path: "f.md",
      text: "FETCHED",
      edit,
    });
    // onLoadingChange went true → false.
    const lc = (callbacks.onLoadingChange as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    expect(lc[0]?.[0]).toBe(true);
    expect(lc[lc.length - 1]?.[0]).toBe(false);
  });

  test("no persisted edit: source equals fetched text and onLoaded reports edit=undefined", async () => {
    const client = makeClient({ getFileContent: mock(async () => "FRESH") });
    const deps = makeDeps();
    const callbacks = makeCallbacks();
    const { result } = renderHook(() =>
      useSelectedFileContent(client, PR, "h", "f.md", "", deps, callbacks),
    );

    await waitFor(() => expect(result.current.source).toBe("FRESH"));
    expect(result.current.baseSource).toBe("FRESH");
    expect(callbacks.onLoaded).toHaveBeenCalledWith({
      path: "f.md",
      text: "FRESH",
      edit: undefined,
    });
  });
});

describe("useSelectedFileContent — error path", () => {
  test("getFileContent throwing surfaces via onError and never calls onLoaded", async () => {
    const client = makeClient({
      getFileContent: mock(async () => {
        throw new Error("boom");
      }),
    });
    const callbacks = makeCallbacks();
    renderHook(() => useSelectedFileContent(client, PR, "h", "f.md", "", makeDeps(), callbacks));

    await waitFor(() => expect(callbacks.onError).toHaveBeenCalled());
    const errCall = (callbacks.onError as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0];
    expect(errCall?.[0]).toBe("boom");
    expect(callbacks.onLoaded).not.toHaveBeenCalled();
  });
});

describe("useSelectedFileContent — cleanup", () => {
  test("unmounting fires onCleanup (lets the parent flush pending writes)", async () => {
    const callbacks = makeCallbacks();
    const { unmount } = renderHook(() =>
      useSelectedFileContent(makeClient(), PR, "h", "f.md", "", makeDeps(), callbacks),
    );
    await waitFor(() => expect(callbacks.onLoaded).toHaveBeenCalled());
    unmount();
    expect(callbacks.onCleanup).toHaveBeenCalled();
  });
});
