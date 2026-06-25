import { describe, expect, test } from "bun:test";
import type { PrRef } from "../../lib/pr/github-transport";
import { embedMetadata } from "../../lib/pr/metadata";
import {
  fetchComments,
  fetchPullRequest,
  fetchRemoteState,
  fetchThreads,
  fetchViewer,
} from "../../lib/pr/remote-fetcher";

const PR: PrRef = { owner: "o", repo: "r", number: 7 };

type CallRecord = { url: string; method: string; body?: string };

function makeFetch(handler: (req: CallRecord) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body as string | undefined;
    const record = { url, method, body };
    calls.push(record);
    return await handler(record);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("remote-fetcher — fetchPullRequest", () => {
  test("maps the GitHub PR JSON to our PullRequest shape", async () => {
    const { fetch } = makeFetch(async () =>
      jsonResponse({
        number: 7,
        title: "Add feature",
        body: "Description",
        state: "open",
        draft: false,
        merged: false,
        head: { sha: "headsha", ref: "topic" },
        base: { ref: "main" },
        user: { login: "alice", avatar_url: "https://avatar/a" },
      }),
    );
    const out = await fetchPullRequest({ token: "t", fetch }, PR);
    expect(out).toEqual({
      owner: "o",
      repo: "r",
      number: 7,
      title: "Add feature",
      body: "Description",
      headSha: "headsha",
      headRef: "topic",
      baseRef: "main",
      state: "open",
      draft: false,
      merged: false,
      author: { login: "alice", avatarUrl: "https://avatar/a" },
    });
  });
});

describe("remote-fetcher — fetchViewer", () => {
  test("maps /user to User", async () => {
    const { fetch } = makeFetch(async () =>
      jsonResponse({ login: "bob", avatar_url: "https://avatar/b" }),
    );
    const out = await fetchViewer({ token: "t", fetch });
    expect(out).toEqual({ login: "bob", avatarUrl: "https://avatar/b" });
  });
});

describe("remote-fetcher — fetchComments", () => {
  test("Bark-authored review comments restore cid / threadId / anchor from metadata", async () => {
    const barkBody = embedMetadata("Looks off", {
      cid: "local-c1",
      threadId: "local-t1",
      path: "src/x.md",
      anchor: {
        sha: "h0",
        range: { sl: 5, sc: 1, el: 5, ec: 10 },
        quote: "hello",
      },
    });
    const { fetch } = makeFetch(async (req) => {
      if (req.url.includes("/pulls/7/comments"))
        return jsonResponse([
          {
            id: 100,
            body: barkBody,
            path: "src/x.md",
            line: 5,
            user: { login: "alice", avatar_url: "" },
          },
        ]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      throw new Error(`unexpected: ${req.url}`);
    });
    const out = await fetchComments({ token: "t", fetch }, PR);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: "local-c1",
      state: "synced",
      remoteId: 100,
      threadId: "local-t1",
      parentLocalId: undefined,
      body: "Looks off",
      author: { login: "alice", avatarUrl: "" },
      path: "src/x.md",
      anchor: {
        sha: "h0",
        range: { sl: 5, sc: 1, el: 5, ec: 10 },
        quote: "hello",
      },
    });
  });

  test("foreign review comments yield synthetic ids and an empty quote (outdated by design)", async () => {
    const { fetch } = makeFetch(async (req) => {
      if (req.url.includes("/pulls/7/comments"))
        return jsonResponse([
          {
            id: 200,
            body: "Foreign body",
            path: "src/x.md",
            line: 10,
            user: { login: "carol", avatar_url: "" },
          },
        ]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      throw new Error(`unexpected: ${req.url}`);
    });
    const out = await fetchComments({ token: "t", fetch }, PR);
    expect(out[0]?.id).toBe("foreign-review-200");
    expect(out[0]?.body).toBe("Foreign body");
    expect(out[0]?.anchor.quote).toBe("");
  });

  test("a reply resolves parentLocalId from the parent's metadata when available", async () => {
    const parentBody = embedMetadata("parent text", {
      cid: "p-cid",
      threadId: "t1",
      path: "src/x.md",
      anchor: {
        sha: "h0",
        range: { sl: 1, sc: 1, el: 1, ec: 2 },
        quote: "p",
      },
    });
    const replyBody = embedMetadata("reply text", {
      cid: "r-cid",
      threadId: "t1",
      path: "src/x.md",
      anchor: {
        sha: "h0",
        range: { sl: 1, sc: 1, el: 1, ec: 2 },
        quote: "p",
      },
    });
    const { fetch } = makeFetch(async (req) => {
      if (req.url.includes("/pulls/7/comments"))
        return jsonResponse([
          {
            id: 1,
            body: parentBody,
            path: "src/x.md",
            line: 1,
            user: { login: "alice", avatar_url: "" },
          },
          {
            id: 2,
            body: replyBody,
            path: "src/x.md",
            line: 1,
            in_reply_to_id: 1,
            user: { login: "alice", avatar_url: "" },
          },
        ]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      throw new Error(`unexpected: ${req.url}`);
    });
    const out = await fetchComments({ token: "t", fetch }, PR);
    const reply = out.find((c) => c.id === "r-cid");
    expect(reply?.parentLocalId).toBe("p-cid");
  });

  test("issue comments without metadata produce foreign comments with empty path", async () => {
    const { fetch } = makeFetch(async (req) => {
      if (req.url.includes("/pulls/7/comments")) return jsonResponse([]);
      if (req.url.includes("/issues/7/comments"))
        return jsonResponse([
          { id: 50, body: "Just a comment", user: { login: "dan", avatar_url: "" } },
        ]);
      throw new Error(`unexpected: ${req.url}`);
    });
    const out = await fetchComments({ token: "t", fetch }, PR);
    expect(out[0]?.id).toBe("foreign-issue-50");
    expect(out[0]?.path).toBe("");
  });
});

describe("remote-fetcher — fetchThreads", () => {
  test("threads inherit local id from a contained Bark comment's metadata.threadId", async () => {
    const barkBody = embedMetadata("x", {
      cid: "c-x",
      threadId: "local-thread-A",
      path: "f.md",
      anchor: {
        sha: "h",
        range: { sl: 1, sc: 1, el: 1, ec: 2 },
        quote: "x",
      },
    });
    const { fetch } = makeFetch(async () =>
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "PRT_A",
                    isResolved: true,
                    comments: {
                      nodes: [{ databaseId: 99, body: barkBody }],
                    },
                  },
                  {
                    id: "PRT_B",
                    isResolved: false,
                    comments: {
                      nodes: [{ databaseId: 100, body: "foreign" }],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const out = await fetchThreads({ token: "t", fetch }, PR);
    expect(out).toEqual([
      { id: "local-thread-A", state: "synced", remoteThreadId: "PRT_A", resolved: true },
      { id: "foreign-thread-PRT_B", state: "synced", remoteThreadId: "PRT_B", resolved: false },
    ]);
  });
});

describe("remote-fetcher — fetchRemoteState", () => {
  test("builds a complete RemoteState in one orchestrated round", async () => {
    let prCalled = false;
    let viewerCalled = false;
    let threadsCalled = false;
    const { fetch } = makeFetch(async (req) => {
      if (req.url.endsWith("/pulls/7")) {
        prCalled = true;
        return jsonResponse({
          number: 7,
          title: "T",
          body: "B",
          state: "open",
          draft: false,
          merged: false,
          head: { sha: "h", ref: "topic" },
          base: { ref: "main" },
          user: { login: "alice", avatar_url: "" },
        });
      }
      if (req.url.endsWith("/user")) {
        viewerCalled = true;
        return jsonResponse({ login: "alice", avatar_url: "" });
      }
      if (req.url.includes("/pulls/7/comments")) return jsonResponse([]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      if (req.url.endsWith("/graphql")) {
        threadsCalled = true;
        return jsonResponse({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        });
      }
      throw new Error(`unexpected: ${req.url}`);
    });
    const out = await fetchRemoteState({ token: "t", fetch }, PR);
    expect(prCalled && viewerCalled && threadsCalled).toBe(true);
    expect(out.pullRequest?.headSha).toBe("h");
    expect(out.viewer?.login).toBe("alice");
    expect(out.fileContents).toEqual([]);
  });

  test("fileContentTargets are fetched in parallel and added to RemoteState", async () => {
    // base64 of "hello"
    const b64Hello = btoa("hello");
    const { fetch } = makeFetch(async (req) => {
      if (req.url.endsWith("/pulls/7"))
        return jsonResponse({
          number: 7,
          title: "T",
          body: "B",
          state: "open",
          draft: false,
          merged: false,
          head: { sha: "h", ref: "topic" },
          base: { ref: "main" },
          user: { login: "alice", avatar_url: "" },
        });
      if (req.url.endsWith("/user")) return jsonResponse({ login: "alice", avatar_url: "" });
      if (req.url.includes("/pulls/7/comments")) return jsonResponse([]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      if (req.url.endsWith("/graphql"))
        return jsonResponse({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        });
      if (req.url.includes("/contents/"))
        return jsonResponse({ content: b64Hello, encoding: "base64" });
      throw new Error(`unexpected: ${req.url}`);
    });
    const out = await fetchRemoteState({ token: "t", fetch }, PR, {
      fileContentTargets: [
        { sha: "h0", path: "a.md" },
        { sha: "h1", path: "b.md" },
      ],
    });
    expect(out.fileContents.map((f) => `${f.sha}:${f.path}:${f.source}`)).toEqual([
      "h0:a.md:hello",
      "h1:b.md:hello",
    ]);
  });
});
