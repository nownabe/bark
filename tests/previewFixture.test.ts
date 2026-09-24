// The local preview (`bun run preview`) serves a fixture PR through a fake
// GitHub API. Running it through the real fetch pipeline keeps the fixture
// from silently rotting as the wire format or fetcher evolves.
import { describe, expect, test } from "bun:test";
import { handleGitHubRequest, PREVIEW_REF } from "../dev/preview/fake-github";
import { fetchRemoteState } from "../lib/pr/remote-fetcher";
import { extractTextAtRange } from "../lib/pr/reanchor";
import type { GitHubClient } from "../lib/pr/github-api";

const client: GitHubClient = {
  token: "preview",
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
    handleGitHubRequest(String(input), init)) as typeof fetch,
};

describe("preview fixture", () => {
  test("loads as a PR with open, resolved, suggestion and foreign threads", async () => {
    const state = await fetchRemoteState(client, PREVIEW_REF);
    expect(state.threads).toHaveLength(4);
    expect(state.threads.filter((t) => t.resolved)).toHaveLength(1);
    expect(state.comments.some((c) => c.body.includes("```suggestion"))).toBe(true);
    expect(state.comments.some((c) => c.id.startsWith("foreign-review-"))).toBe(true);
  });

  test("every Bark comment's anchor quotes the head file exactly", async () => {
    const state = await fetchRemoteState(client, PREVIEW_REF);
    const bark = state.comments.filter((c) => c.anchor.sha !== "");
    expect(bark.length).toBeGreaterThan(0);
    for (const c of bark) {
      const file = state.fileContents.find((f) => f.sha === c.anchor.sha && f.path === c.path);
      expect(extractTextAtRange(file!.source, c.anchor.range)).toBe(c.anchor.quote);
    }
  });

  test("writes are refused so nothing pretends to reach GitHub", async () => {
    const res = handleGitHubRequest(
      `https://api.github.com/repos/${PREVIEW_REF.owner}/${PREVIEW_REF.repo}/pulls/1/reviews`,
      { method: "POST" },
    );
    expect(res.status).toBe(403);
  });
});
