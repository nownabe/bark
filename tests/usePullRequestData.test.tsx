import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { usePullRequestData } from "../entrypoints/review/hooks/usePullRequestData";
import type { GitHubClient } from "../lib/pr/github-api";
import type { PrRef } from "../lib/github";

afterEach(() => {
  cleanup();
});

const PR: PrRef = { owner: "o", repo: "r", number: 7 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const RAW_PULL = {
  number: 7,
  title: "Add docs",
  body: null,
  state: "open",
  draft: false,
  merged: false,
  head: { sha: "abcdef0", ref: "feature" },
  base: { ref: "main" },
  user: { login: "alice", avatar_url: "" },
};

const RAW_FILES = [
  { filename: "README.md", status: "modified", patch: "" },
  { filename: "src/app.ts", status: "modified", patch: "" },
  { filename: "GONE.md", status: "removed", patch: "" },
];

const RAW_USER = { login: "alice", avatar_url: "" };

/** Stubbed-fetch client (the new data layer's injection seam). Routes the
 *  three GET endpoints the hook needs; `routes` overrides per-URL substring. */
function makeClient(routes: Record<string, () => Response | Promise<Response>> = {}): {
  client: GitHubClient;
  fetch: ReturnType<typeof mock>;
} {
  const f = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [needle, handler] of Object.entries(routes)) {
      if (url.includes(needle)) return handler();
    }
    if (url.includes("/pulls/7/files")) return json(RAW_FILES);
    if (url.includes("/pulls/7")) return json(RAW_PULL);
    if (url.endsWith("/user")) return json(RAW_USER);
    throw new Error(`unexpected fetch: ${url}`);
  });
  return {
    client: { token: "t", fetch: f as unknown as typeof fetch, delay: async () => {} },
    fetch: f,
  };
}

describe("usePullRequestData — happy path", () => {
  test("on mount: fetches PullInfo + files + viewer and reflects them in state", async () => {
    const { client } = makeClient();
    const { result } = renderHook(() => usePullRequestData(client, PR));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pull?.title).toBe("Add docs");
    expect(result.current.pull?.author).toBe("alice");
    expect(result.current.headSha).toBe("abcdef0");
    expect(result.current.headRef).toBe("feature");
    expect(result.current.viewerLogin).toBe("alice");
    expect(result.current.error).toBeNull();
    expect(result.current.needsInstall).toBe(false);
  });

  test("files keep only non-removed .md entries", async () => {
    const { client } = makeClient();
    const { result } = renderHook(() => usePullRequestData(client, PR));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.files.map((f) => f.path)).toEqual(["README.md"]);
  });
});

describe("usePullRequestData — gating", () => {
  test("does nothing while client or ref is null", async () => {
    const noClient = renderHook(() => usePullRequestData(null, PR));
    await new Promise((r) => setTimeout(r, 10));
    expect(noClient.result.current.loading).toBe(false);
    expect(noClient.result.current.pull).toBeNull();
    noClient.unmount();

    const { client } = makeClient();
    const noRef = renderHook(() => usePullRequestData(client, null));
    await new Promise((r) => setTimeout(r, 10));
    expect(noRef.result.current.loading).toBe(false);
    expect(noRef.result.current.pull).toBeNull();
  });
});

describe("usePullRequestData — error", () => {
  test("a 404 from the pull fetch surfaces error + flags needsInstall", async () => {
    const { client } = makeClient({ "/pulls/7": () => json({}, 404) });
    const { result } = renderHook(() => usePullRequestData(client, PR));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("Not Found (404)");
    expect(result.current.needsInstall).toBe(true);
  });

  test("a 403 also flags needsInstall", async () => {
    const { client } = makeClient({ "/pulls/7": () => json({}, 403) });
    const { result } = renderHook(() => usePullRequestData(client, PR));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.needsInstall).toBe(true);
  });

  test("a 500 surfaces error but leaves needsInstall false", async () => {
    const { client } = makeClient({ "/pulls/7": () => json({}, 500) });
    const { result } = renderHook(() => usePullRequestData(client, PR));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("500");
    expect(result.current.needsInstall).toBe(false);
  });
});

describe("usePullRequestData — viewer fetch falls back gracefully", () => {
  test("if the viewer fetch throws, the PR still loads and viewerLogin stays null", async () => {
    const { client } = makeClient({ "/user": () => json({}, 401) });
    const { result } = renderHook(() => usePullRequestData(client, PR));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pull?.title).toBe("Add docs");
    expect(result.current.viewerLogin).toBeNull();
    expect(result.current.error).toBeNull();
  });
});

describe("usePullRequestData — reload", () => {
  test("reload() re-runs the fetch (pull fetched again)", async () => {
    const { client, fetch } = makeClient();
    const pullCalls = () =>
      fetch.mock.calls.filter(
        (c) => String(c[0]).includes("/pulls/7") && !String(c[0]).includes("/files"),
      ).length;
    const { result } = renderHook(() => usePullRequestData(client, PR));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(pullCalls()).toBe(1);

    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => {
      expect(pullCalls()).toBe(2);
    });
  });
});

describe("usePullRequestData — reset", () => {
  test("reset() wipes every field", async () => {
    const { client } = makeClient();
    const { result } = renderHook(() => usePullRequestData(client, PR));
    await waitFor(() => expect(result.current.pull).not.toBeNull());

    act(() => {
      result.current.reset();
    });
    expect(result.current.pull).toBeNull();
    expect(result.current.files).toEqual([]);
    expect(result.current.headSha).toBeNull();
    expect(result.current.headRef).toBeNull();
    expect(result.current.viewerLogin).toBeNull();
    expect(result.current.needsInstall).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
