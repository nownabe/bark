import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  type SelectedFileContentCallbacks,
  type SelectedFileContentDeps,
  useSelectedFileContent,
} from "../entrypoints/review/hooks/useSelectedFileContent";
import type { SuggestionEdit } from "../lib/drafts";
import type { GitHubClient } from "../lib/pr/github-api";
import type { PrRef } from "../lib/pr/types";

afterEach(() => {
  cleanup();
});

const PR: PrRef = { owner: "o", repo: "r", number: 7 };

/** A GitHub contents-API response body carrying `text`. */
function contentsJson(text: string): Response {
  return new Response(JSON.stringify({ content: btoa(text), encoding: "base64" }), {
    status: 200,
  });
}

/** New-layer client with a stubbed fetch (the data layer's injection seam). */
function makeClient(handler: () => Response | Promise<Response> = () => contentsJson("FETCHED")): {
  client: GitHubClient;
  fetch: ReturnType<typeof mock>;
} {
  const f = mock(async () => handler());
  return {
    client: { token: "t", fetch: f as unknown as typeof fetch, delay: async () => {} },
    fetch: f,
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
    const { client, fetch } = makeClient();
    const deps = makeDeps();
    const callbacks = makeCallbacks();

    renderHook(() => useSelectedFileContent(null, PR, "h", "f.md", "", deps, callbacks));
    renderHook(() => useSelectedFileContent(client, null, "h", "f.md", "", deps, callbacks));
    renderHook(() => useSelectedFileContent(client, PR, null, "f.md", "", deps, callbacks));
    renderHook(() => useSelectedFileContent(client, PR, "h", null, "", deps, callbacks));

    await new Promise((r) => setTimeout(r, 10));
    expect(fetch).not.toHaveBeenCalled();
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
    const { client } = makeClient(() => contentsJson("FETCHED"));
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
    // ready flipped true once the fetched content was applied (issue #185).
    expect(result.current.ready).toBe(true);
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
    const { client } = makeClient(() => contentsJson("FRESH"));
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

describe("useSelectedFileContent — ready gating (issue #185)", () => {
  test("editable (ready) when there is nothing to fetch", () => {
    const { result } = renderHook(() =>
      useSelectedFileContent(null, PR, "h", "f.md", "", makeDeps(), makeCallbacks()),
    );
    expect(result.current.ready).toBe(true);
  });

  test("stays not-ready while the fetch is in flight, then flips ready", async () => {
    let resolveFetch: ((v: Response) => void) | undefined;
    const { client } = makeClient(
      () =>
        new Promise<Response>((r) => {
          resolveFetch = r;
        }),
    );
    const { result } = renderHook(() =>
      useSelectedFileContent(client, PR, "h", "f.md", "", makeDeps(), makeCallbacks()),
    );
    // Content still loading → editor must be held read-only.
    await waitFor(() => expect(result.current.ready).toBe(false));
    resolveFetch?.(contentsJson("FRESH"));
    await waitFor(() => expect(result.current.ready).toBe(true));
  });
});

describe("useSelectedFileContent — error path", () => {
  test("a failing fetch surfaces via onError and never calls onLoaded", async () => {
    const { client } = makeClient(() => new Response("{}", { status: 404 }));
    const callbacks = makeCallbacks();
    const { result } = renderHook(() =>
      useSelectedFileContent(client, PR, "h", "f.md", "", makeDeps(), callbacks),
    );

    await waitFor(() => expect(callbacks.onError).toHaveBeenCalled());
    const errCall = (callbacks.onError as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0];
    expect(String(errCall?.[0])).toContain("404");
    expect(callbacks.onLoaded).not.toHaveBeenCalled();
    // A failed load leaves the editor read-only (source still holds the
    // previous file's text).
    expect(result.current.ready).toBe(false);
  });
});

describe("useSelectedFileContent — cleanup", () => {
  test("unmounting fires onCleanup (lets the parent flush pending writes)", async () => {
    const callbacks = makeCallbacks();
    const { client } = makeClient();
    const { unmount } = renderHook(() =>
      useSelectedFileContent(client, PR, "h", "f.md", "", makeDeps(), callbacks),
    );
    await waitFor(() => expect(callbacks.onLoaded).toHaveBeenCalled());
    unmount();
    expect(callbacks.onCleanup).toHaveBeenCalled();
  });
});
