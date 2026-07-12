import { describe, expect, test } from "bun:test";
import { bootstrapPullRequest } from "../../lib/pr/bootstrap";
import type { BrowserStorageAPI } from "../../lib/pr/chrome-storage";
import type { PrRef } from "../../lib/pr/github-transport";
import { embedMetadata } from "../../lib/pr/metadata";

const PR: PrRef = { owner: "o", repo: "r", number: 7 };

function fakeStorage(): BrowserStorageAPI {
  const store: Record<string, unknown> = {};
  return {
    async get(key) {
      return key in store ? { [key]: store[key] } : {};
    },
    async set(items) {
      Object.assign(store, items);
    },
    async remove(key) {
      delete store[key];
    },
  };
}

type Handler = (req: {
  url: string;
  method: string;
  body?: string;
}) => Response | Promise<Response>;

function makeFetch(handler: Handler): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return await handler({
      url,
      method: init?.method ?? "GET",
      body: init?.body as string | undefined,
    });
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const PR_JSON = {
  number: 7,
  title: "T",
  body: "B",
  state: "open",
  draft: false,
  merged: false,
  head: { sha: "headsha", ref: "topic" },
  base: { ref: "main" },
  user: { login: "alice", avatar_url: "" },
};

const VIEWER_JSON = { login: "alice", avatar_url: "" };

const PATCH = ["@@ -1,2 +1,3 @@", " a", "+inserted", " b"].join("\n");

describe("bootstrap — full happy path", () => {
  test("hydrates LocalState, fetches RemoteState + changedFiles, populates the Repository", async () => {
    const storage = fakeStorage();
    const fetch = makeFetch(async (req) => {
      if (req.url.endsWith("/pulls/7")) return jsonResponse(PR_JSON);
      if (req.url.endsWith("/user")) return jsonResponse(VIEWER_JSON);
      if (req.url.includes("/pulls/7/commits")) return jsonResponse([]);
      if (req.url.includes("/pulls/7/reviews")) return jsonResponse([]);
      if (req.url.includes("/pulls/7/comments")) return jsonResponse([]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      if (req.url.endsWith("/graphql"))
        return jsonResponse({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        });
      if (req.url.includes("/pulls/7/files"))
        return jsonResponse([{ filename: "README.md", status: "modified", patch: PATCH }]);
      if (req.url.includes("/contents/"))
        return jsonResponse({ content: btoa("a\ninserted\nb"), encoding: "base64" });
      throw new Error(`unexpected: ${req.url}`);
    });

    const { repository, refresh } = await bootstrapPullRequest({
      token: "t",
      prRef: PR,
      storage,
      fetch,
    });

    expect(repository.getRemoteState().pullRequest?.headSha).toBe("headsha");
    expect(repository.getRemoteState().viewer?.login).toBe("alice");
    // The changed-file listing rides into RemoteState so AppState can derive
    // the file selector from the Repository (no parallel fetch in the UI).
    expect(repository.getRemoteState().changedFiles).toEqual([
      { path: "README.md", status: "modified", patch: PATCH },
    ]);
    expect(refresh).toBeInstanceOf(Function);
  });

  test("a persisted LocalState is restored before the initial refresh", async () => {
    const storage = fakeStorage();
    // Pre-populate storage with a state that includes a draft.
    await storage.set({
      "pr:o/r#7:state": {
        comments: [
          {
            id: "draft-1",
            state: "draft",
            threadId: "t-x",
            body: "in-progress",
            author: { login: "alice" },
            path: "README.md",
            anchor: {
              sha: "headsha",
              range: { sl: 1, sc: 1, el: 1, ec: 2 },
              quote: "a",
            },
          },
        ],
        threads: [],
        fileEdits: [],
        fileContents: [],
        pullRequest: null,
        viewer: null,
      },
    });

    const fetch = makeFetch(async (req) => {
      if (req.url.endsWith("/pulls/7")) return jsonResponse(PR_JSON);
      if (req.url.endsWith("/user")) return jsonResponse(VIEWER_JSON);
      if (req.url.includes("/pulls/7/commits")) return jsonResponse([]);
      if (req.url.includes("/pulls/7/reviews")) return jsonResponse([]);
      if (req.url.includes("/pulls/7/comments")) return jsonResponse([]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      if (req.url.endsWith("/graphql"))
        return jsonResponse({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        });
      if (req.url.includes("/pulls/7/files")) return jsonResponse([]);
      if (req.url.includes("/contents/"))
        return jsonResponse({ content: btoa("a\nb"), encoding: "base64" });
      throw new Error(`unexpected: ${req.url}`);
    });

    const { repository } = await bootstrapPullRequest({
      token: "t",
      prRef: PR,
      storage,
      fetch,
    });

    const drafts = repository.getLocalState().comments.filter((c) => c.state === "draft");
    expect(drafts.map((c) => c.id)).toEqual(["draft-1"]);
  });

  test("comments with an empty anchor.sha (foreign) are skipped from fileContentTargets", async () => {
    // Foreign comments arrive from remote-fetcher with `anchor.sha = ""`
    // because they were not authored by Bark and carry no metadata. After
    // mergeRemoteIntoLocal they live in LocalState too, so a naive
    // anchorTargets() would feed `{sha:"", path:"foo.md"}` to
    // fetchFileContent — which then hits `/contents/foo.md?ref=` and 404s.
    const storage = fakeStorage();
    await storage.set({
      "pr:o/r#7:state": {
        comments: [
          {
            id: "foreign-review-42",
            state: "synced",
            remoteId: 42,
            threadId: "foreign-thread-review-42",
            body: "old foreign",
            author: { login: "carol" },
            path: "test.md",
            anchor: { sha: "", range: { sl: 1, sc: 1, el: 1, ec: 1 }, quote: "" },
          },
        ],
        threads: [],
        fileEdits: [],
        fileContents: [],
        pullRequest: null,
        viewer: null,
      },
    });

    const contentUrls: string[] = [];
    const fetch = makeFetch(async (req) => {
      if (req.url.includes("/contents/")) {
        contentUrls.push(req.url);
        return jsonResponse({ content: btoa(""), encoding: "base64" });
      }
      if (req.url.endsWith("/pulls/7")) return jsonResponse(PR_JSON);
      if (req.url.endsWith("/user")) return jsonResponse(VIEWER_JSON);
      if (req.url.includes("/pulls/7/commits")) return jsonResponse([]);
      if (req.url.includes("/pulls/7/reviews")) return jsonResponse([]);
      if (req.url.includes("/pulls/7/comments")) return jsonResponse([]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      if (req.url.endsWith("/graphql"))
        return jsonResponse({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        });
      if (req.url.includes("/pulls/7/files")) return jsonResponse([]);
      throw new Error(`unexpected: ${req.url}`);
    });

    await bootstrapPullRequest({ token: "t", prRef: PR, storage, fetch });

    expect(contentUrls).toEqual([]);
  });

  test("refresh() rebuilds isInDiff so the next sync routes correctly", async () => {
    const storage = fakeStorage();
    let phase = "initial";
    const calls: string[] = [];
    const barkBody = embedMetadata("hello", {
      cid: "c1",
      threadId: "t1",
      path: "README.md",
      anchor: {
        sha: "headsha",
        range: { sl: 2, sc: 1, el: 2, ec: 5 },
        quote: "ins",
      },
    });
    const fetch = makeFetch(async (req) => {
      calls.push(`${phase}:${req.url.replace("https://api.github.com", "")}`);
      if (req.url.endsWith("/pulls/7")) return jsonResponse(PR_JSON);
      if (req.url.endsWith("/user")) return jsonResponse(VIEWER_JSON);
      if (req.url.includes("/pulls/7/commits")) return jsonResponse([]);
      if (req.url.includes("/pulls/7/reviews")) return jsonResponse([]);
      if (req.url.includes("/pulls/7/comments"))
        return jsonResponse([
          {
            id: 99,
            body: barkBody,
            path: "README.md",
            line: 2,
            user: { login: "alice", avatar_url: "" },
          },
        ]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      if (req.url.endsWith("/graphql"))
        return jsonResponse({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        });
      if (req.url.includes("/pulls/7/files"))
        return jsonResponse([{ filename: "README.md", status: "modified", patch: PATCH }]);
      if (req.url.includes("/contents/"))
        return jsonResponse({ content: btoa("a\ninserted\nb"), encoding: "base64" });
      throw new Error(`unexpected: ${req.url}`);
    });

    const { repository, refresh } = await bootstrapPullRequest({
      token: "t",
      prRef: PR,
      storage,
      fetch,
    });

    // Initial bootstrap fetched comments + files; the synced comment is present.
    expect(repository.getLocalState().comments.find((c) => c.id === "c1")?.state).toBe("synced");

    // Explicit refresh runs the same pipeline again.
    phase = "second";
    await refresh();
    const secondPhaseCalls = calls.filter((c) => c.startsWith("second:"));
    expect(secondPhaseCalls.some((c) => c.includes("/pulls/7/files"))).toBe(true);
    expect(secondPhaseCalls.some((c) => c.includes("/pulls/7"))).toBe(true);
    // The viewer is fetched once at bootstrap and NOT refreshed (ADR 0005
    // §2: it changes only on re-auth) — but it stays populated.
    expect(secondPhaseCalls.some((c) => c.includes("/user"))).toBe(false);
    expect(repository.getRemoteState().viewer?.login).toBe("alice");
  });
});
