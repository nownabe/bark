import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useBaselineContent } from "../entrypoints/review/hooks/useBaselineContent";
import type { PrRef } from "../lib/github";
import type { GitHubClient } from "../lib/pr/github-api";

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

/** New-layer client with a stubbed fetch (the data layer's injection seam).
 *  The handler receives the requested URL so tests can key content off the
 *  `?ref=<sha>` query. */
function makeClient(
  handler: (url: string) => Response | Promise<Response> = () => contentsJson("BASELINE"),
): { client: GitHubClient; fetch: ReturnType<typeof mock> } {
  const f = mock(async (input: RequestInfo | URL) => handler(String(input)));
  return {
    client: { token: "t", fetch: f as unknown as typeof fetch, delay: async () => {} },
    fetch: f,
  };
}

describe("useBaselineContent — gating", () => {
  test("null baselineSha → no fetch, baseline is null", async () => {
    const { client, fetch } = makeClient();
    const { result } = renderHook(() => useBaselineContent(client, PR, null, "f.md"));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  test("no client / ref / path → no fetch", async () => {
    const { client, fetch } = makeClient();
    renderHook(() => useBaselineContent(null, PR, "sha", "f.md"));
    renderHook(() => useBaselineContent(client, null, "sha", "f.md"));
    renderHook(() => useBaselineContent(client, PR, "sha", null));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("useBaselineContent — fetch", () => {
  test("fetches the file at the baseline sha and returns its content", async () => {
    const { client, fetch } = makeClient(() => contentsJson("OLD TEXT"));
    const { result } = renderHook(() => useBaselineContent(client, PR, "base-sha", "f.md"));
    await waitFor(() => expect(result.current).toBe("OLD TEXT"));
    const url = String(fetch.mock.calls[0]?.[0]);
    expect(url).toContain("/repos/o/r/contents/f.md");
    expect(url).toContain("ref=base-sha");
  });

  test("404 (file absent at baseline) is non-fatal: baseline resolves to null", async () => {
    const { client } = makeClient(() => new Response("{}", { status: 404 }));
    const { result } = renderHook(() => useBaselineContent(client, PR, "base-sha", "new.md"));
    // The file did not exist at the baseline commit — treat as "no redline",
    // never throw. Give the effect a tick to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current).toBeNull();
  });

  test("refetches when the baseline sha changes", async () => {
    const { client } = makeClient((url) => {
      const sha = /ref=([^&]+)/.exec(url)?.[1] ?? "?";
      return contentsJson(`at-${sha}`);
    });
    const { result, rerender } = renderHook(
      ({ sha }: { sha: string }) => useBaselineContent(client, PR, sha, "f.md"),
      { initialProps: { sha: "s1" } },
    );
    await waitFor(() => expect(result.current).toBe("at-s1"));
    rerender({ sha: "s2" });
    await waitFor(() => expect(result.current).toBe("at-s2"));
  });
});
