import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  type PullRequestClient,
  usePullRequestData,
} from "../entrypoints/review/hooks/usePullRequestData";
import { GitHubApiError, type ChangedFile, type PrRef, type PullInfo } from "../lib/github";

afterEach(() => {
  cleanup();
});

const PR: PrRef = { owner: "o", repo: "r", number: 7 };

function makePull(overrides: Partial<PullInfo> = {}): PullInfo {
  return {
    title: "Add docs",
    body: "",
    author: "alice",
    headSha: "abcdef0",
    headRef: "feature",
    state: "open",
    draft: false,
    merged: false,
    ...overrides,
  };
}

function makeFiles(): ChangedFile[] {
  return [{ path: "README.md", status: "modified", patch: "" }];
}

function makeClient(overrides: Partial<PullRequestClient> = {}): PullRequestClient {
  return {
    getPull: mock(async () => makePull()),
    listMarkdownFiles: mock(async () => makeFiles()),
    getAuthenticatedUser: mock(async () => ({ login: "alice" })),
    ...overrides,
  };
}

describe("usePullRequestData — happy path", () => {
  test("on mount: fetches PullInfo + files + viewer and reflects them in state", async () => {
    const client = makeClient();
    const { result } = renderHook(() => usePullRequestData(client, PR));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pull?.title).toBe("Add docs");
    expect(result.current.files.map((f) => f.path)).toEqual(["README.md"]);
    expect(result.current.headSha).toBe("abcdef0");
    expect(result.current.headRef).toBe("feature");
    expect(result.current.viewerLogin).toBe("alice");
    expect(result.current.error).toBeNull();
    expect(result.current.needsInstall).toBe(false);
  });
});

describe("usePullRequestData — gating", () => {
  test("does nothing while client or ref is null", async () => {
    const noClient = renderHook(() => usePullRequestData(null, PR));
    await new Promise((r) => setTimeout(r, 10));
    expect(noClient.result.current.loading).toBe(false);
    expect(noClient.result.current.pull).toBeNull();
    noClient.unmount();

    const noRef = renderHook(() => usePullRequestData(makeClient(), null));
    await new Promise((r) => setTimeout(r, 10));
    expect(noRef.result.current.loading).toBe(false);
    expect(noRef.result.current.pull).toBeNull();
  });
});

describe("usePullRequestData — error", () => {
  test("a 404 from getPull surfaces error + flags needsInstall", async () => {
    const client = makeClient({
      getPull: mock(async () => {
        throw new GitHubApiError(404, "Not Found");
      }),
    });
    const { result } = renderHook(() => usePullRequestData(client, PR));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("Not Found (404)");
    expect(result.current.needsInstall).toBe(true);
  });

  test("a 403 also flags needsInstall", async () => {
    const client = makeClient({
      getPull: mock(async () => {
        throw new GitHubApiError(403, "Forbidden");
      }),
    });
    const { result } = renderHook(() => usePullRequestData(client, PR));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.needsInstall).toBe(true);
  });

  test("a 500 surfaces error but leaves needsInstall false", async () => {
    const client = makeClient({
      getPull: mock(async () => {
        throw new GitHubApiError(500, "Server");
      }),
    });
    const { result } = renderHook(() => usePullRequestData(client, PR));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("Server");
    expect(result.current.needsInstall).toBe(false);
  });
});

describe("usePullRequestData — viewer fetch falls back gracefully", () => {
  test("if getAuthenticatedUser throws, the PR still loads and viewerLogin stays null", async () => {
    const client = makeClient({
      getAuthenticatedUser: mock(async () => {
        throw new Error("scope missing");
      }),
    });
    const { result } = renderHook(() => usePullRequestData(client, PR));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pull?.title).toBe("Add docs");
    expect(result.current.viewerLogin).toBeNull();
    expect(result.current.error).toBeNull();
  });
});

describe("usePullRequestData — reload", () => {
  test("reload() re-runs the fetch (getPull called again)", async () => {
    const getPull = mock(async () => makePull());
    const client = makeClient({ getPull });
    const { result } = renderHook(() => usePullRequestData(client, PR));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getPull).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => {
      expect(getPull).toHaveBeenCalledTimes(2);
    });
  });
});

describe("usePullRequestData — reset", () => {
  test("reset() wipes every field", async () => {
    const client = makeClient();
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
