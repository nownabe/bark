import { describe, expect, test } from "bun:test";
import type { PrRef } from "../../lib/pr/github-transport";
import { embedMetadata } from "../../lib/pr/metadata";
import {
  fetchComments,
  fetchFileContent,
  fetchPullRequest,
  fetchRemoteState,
  fetchThreads,
  fetchViewer,
  normalizeComments,
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
    // When GitHub gives us a line number (in-diff comment), preserve it.
    expect(out[0]?.anchor.range.el).toBe(10);
  });

  test("foreign review comment with line=null encodes 'no line' as range.el = 0", async () => {
    // A review comment whose original line no longer exists in the head
    // (commit history moved past it) — GitHub returns `line: null`. The
    // UI uses range.el === 0 to mean "no line", so it can either hide
    // the comment (Bark is line-bound only) or render it separately.
    const { fetch } = makeFetch(async (req) => {
      if (req.url.includes("/pulls/7/comments"))
        return jsonResponse([
          {
            id: 201,
            body: "Outdated foreign",
            path: "src/x.md",
            line: null,
            user: { login: "carol", avatar_url: "" },
          },
        ]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      throw new Error(`unexpected: ${req.url}`);
    });
    const out = await fetchComments({ token: "t", fetch }, PR);
    expect(out[0]?.anchor.range.sl).toBe(0);
    expect(out[0]?.anchor.range.el).toBe(0);
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

  test("legacy v1 resolve-marker comments are dropped, not rendered (issue #186)", async () => {
    const v1Marker = (event: "resolve" | "unresolve") =>
      btoa(
        JSON.stringify({
          cid: `evt-${event}`,
          thread: "t-1",
          path: "x.md",
          sha: "h",
          quote: "q",
          range: { sl: 1, sc: 1, el: 1, ec: 2 },
          event,
        }),
      );
    const { fetch } = makeFetch(async (req) => {
      if (req.url.includes("/pulls/7/comments"))
        return jsonResponse([
          {
            id: 300,
            body: `Resolved via Bark.\n\n<!-- bark:v1 ${v1Marker("resolve")} -->`,
            path: "x.md",
            line: 1,
            user: { login: "alice", avatar_url: "" },
          },
        ]);
      if (req.url.includes("/issues/7/comments"))
        return jsonResponse([
          {
            id: 301,
            body: `Reopened via Bark.\n\n<!-- bark:v1 ${v1Marker("unresolve")} -->`,
            user: { login: "alice", avatar_url: "" },
          },
        ]);
      throw new Error(`unexpected: ${req.url}`);
    });
    const out = await fetchComments({ token: "t", fetch }, PR);
    expect(out).toEqual([]);
  });
});

describe("remote-fetcher — normalizeComments foreign threadId (issues #180 / #181)", () => {
  const foreignReview = (id: number, inReplyTo?: number) => ({
    id,
    body: `foreign ${id}`,
    path: "f.md",
    line: 3 as number | null,
    ...(inReplyTo !== undefined ? { in_reply_to_id: inReplyTo } : {}),
    user: { login: "carol", avatar_url: "" },
  });

  test("foreign comments in the same GraphQL thread share one threadId (#181)", () => {
    // Two foreign comments that GitHub groups under one review thread node.
    const map = new Map<number, string>([
      [10, "PRT_shared"],
      [11, "PRT_shared"],
    ]);
    const out = normalizeComments([foreignReview(10), foreignReview(11, 10)], [], map);
    expect(out[0]?.threadId).toBe("foreign-thread-PRT_shared");
    expect(out[1]?.threadId).toBe("foreign-thread-PRT_shared");
    // Both group under one thread instead of splitting into per-comment threads.
    expect(new Set(out.map((c) => c.threadId)).size).toBe(1);
  });

  test("foreign comment threadId matches the Thread entity fetchThreads builds (#180)", () => {
    const map = new Map<number, string>([[42, "PRT_x"]]);
    const [comment] = normalizeComments([foreignReview(42)], [], map);
    // fetchThreads names an all-foreign thread `foreign-thread-<nodeId>`.
    expect(comment?.threadId).toBe("foreign-thread-PRT_x");
  });

  test("falls back to a per-comment threadId when thread data is unavailable", () => {
    const [comment] = normalizeComments([foreignReview(7)], [], new Map());
    expect(comment?.threadId).toBe("foreign-thread-review-7");
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

  test("threads past the first reviewThreads page keep their resolved state (issue #178)", async () => {
    const { fetch } = makeFetch(async (req) => {
      const vars = (JSON.parse(req.body ?? "{}") as { variables: Record<string, unknown> })
        .variables;
      if (vars.cursor === null || vars.cursor === undefined) {
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRT_page1",
                      isResolved: false,
                      comments: {
                        nodes: [{ databaseId: 1, body: "a" }],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "CUR1" },
                },
              },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "PRT_page2",
                    isResolved: true,
                    comments: {
                      nodes: [{ databaseId: 2, body: "b" }],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      });
    });
    const out = await fetchThreads({ token: "t", fetch }, PR);
    expect(out).toEqual([
      {
        id: "foreign-thread-PRT_page1",
        state: "synced",
        remoteThreadId: "PRT_page1",
        resolved: false,
      },
      {
        id: "foreign-thread-PRT_page2",
        state: "synced",
        remoteThreadId: "PRT_page2",
        resolved: true,
      },
    ]);
  });

  test("a Bark thread whose metadata comment is on a later comments page is not misclassified as foreign (issue #178)", async () => {
    const barkBody = embedMetadata("x", {
      cid: "c-deep",
      threadId: "local-thread-deep",
      path: "f.md",
      anchor: {
        sha: "h",
        range: { sl: 1, sc: 1, el: 1, ec: 2 },
        quote: "x",
      },
    });
    const { fetch } = makeFetch(async (req) => {
      const vars = (JSON.parse(req.body ?? "{}") as { variables: Record<string, unknown> })
        .variables;
      if (vars.threadId === undefined) {
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRT_deep",
                      isResolved: false,
                      comments: {
                        nodes: [{ databaseId: 1, body: "foreign reply" }],
                        pageInfo: { hasNextPage: true, endCursor: "CC1" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          node: {
            comments: {
              nodes: [{ databaseId: 2, body: barkBody }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    });
    const out = await fetchThreads({ token: "t", fetch }, PR);
    expect(out).toEqual([
      { id: "local-thread-deep", state: "synced", remoteThreadId: "PRT_deep", resolved: false },
    ]);
  });
});

describe("remote-fetcher — fetchFileContent URL encoding", () => {
  test("preserves slashes in nested paths (per-segment percent encoding)", async () => {
    let calledUrl = "";
    const { fetch } = makeFetch(async (req) => {
      calledUrl = req.url;
      return jsonResponse({ content: btoa("body"), encoding: "base64" });
    });
    await fetchFileContent({ token: "t", fetch }, PR, "abc", "docs/sub dir/file.md");
    expect(calledUrl).toContain("/contents/docs/sub%20dir/file.md");
    expect(calledUrl).not.toContain("%2F");
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

  test("fileContents are auto-collected from every fetched comment's anchor (Bark-authored)", async () => {
    const barkBody = embedMetadata("hi", {
      cid: "c1",
      threadId: "t1",
      path: "src/x.md",
      anchor: {
        sha: "old-sha",
        range: { sl: 5, sc: 1, el: 5, ec: 10 },
        quote: "hello",
      },
    });
    const b64 = btoa("hello world");
    const contentsCalls: string[] = [];
    const { fetch } = makeFetch(async (req) => {
      if (req.url.endsWith("/pulls/7"))
        return jsonResponse({
          number: 7,
          title: "T",
          body: "B",
          state: "open",
          draft: false,
          merged: false,
          head: { sha: "head", ref: "topic" },
          base: { ref: "main" },
          user: { login: "alice", avatar_url: "" },
        });
      if (req.url.endsWith("/user")) return jsonResponse({ login: "alice", avatar_url: "" });
      if (req.url.includes("/pulls/7/comments"))
        return jsonResponse([
          {
            id: 1,
            body: barkBody,
            path: "src/x.md",
            line: 5,
            user: { login: "alice", avatar_url: "" },
          },
        ]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      if (req.url.endsWith("/graphql"))
        return jsonResponse({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        });
      if (req.url.includes("/contents/")) {
        contentsCalls.push(req.url);
        return jsonResponse({ content: b64, encoding: "base64" });
      }
      throw new Error(`unexpected: ${req.url}`);
    });

    const out = await fetchRemoteState({ token: "t", fetch }, PR);

    // No explicit fileContentTargets — the orchestrator should have
    // pulled the old source for the bark comment's `(anchor.sha, path)`
    // entirely on its own.
    expect(out.fileContents).toHaveLength(1);
    expect(out.fileContents[0]?.sha).toBe("old-sha");
    expect(out.fileContents[0]?.path).toBe("src/x.md");
    expect(out.fileContents[0]?.source).toBe("hello world");
    expect(contentsCalls).toHaveLength(1);
  });

  test("auto-collect dedups against caller-provided fileContentTargets", async () => {
    const barkBody = embedMetadata("hi", {
      cid: "c1",
      threadId: "t1",
      path: "x.md",
      anchor: {
        sha: "old",
        range: { sl: 1, sc: 1, el: 1, ec: 2 },
        quote: "x",
      },
    });
    const contentsCalls: string[] = [];
    const { fetch } = makeFetch(async (req) => {
      if (req.url.endsWith("/pulls/7"))
        return jsonResponse({
          number: 7,
          title: "T",
          body: "B",
          state: "open",
          draft: false,
          merged: false,
          head: { sha: "head", ref: "topic" },
          base: { ref: "main" },
          user: { login: "alice", avatar_url: "" },
        });
      if (req.url.endsWith("/user")) return jsonResponse({ login: "alice", avatar_url: "" });
      if (req.url.includes("/pulls/7/comments"))
        return jsonResponse([
          {
            id: 1,
            body: barkBody,
            path: "x.md",
            line: 1,
            user: { login: "alice", avatar_url: "" },
          },
        ]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      if (req.url.endsWith("/graphql"))
        return jsonResponse({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        });
      if (req.url.includes("/contents/")) {
        contentsCalls.push(req.url);
        return jsonResponse({ content: btoa("x"), encoding: "base64" });
      }
      throw new Error(`unexpected: ${req.url}`);
    });

    // Pass the same (sha, path) that the bark comment already requires.
    const out = await fetchRemoteState({ token: "t", fetch }, PR, {
      fileContentTargets: [{ sha: "old", path: "x.md" }],
    });
    expect(out.fileContents).toHaveLength(1);
    expect(contentsCalls).toHaveLength(1);
  });

  test("a 404 on one file is non-fatal — surviving fetches still land in fileContents", async () => {
    const barkBody = (cid: string, sha: string, path: string) =>
      embedMetadata("hi", {
        cid,
        threadId: cid,
        path,
        anchor: { sha, range: { sl: 1, sc: 1, el: 1, ec: 2 }, quote: "x" },
      });
    const { fetch } = makeFetch(async (req) => {
      if (req.url.endsWith("/pulls/7"))
        return jsonResponse({
          number: 7,
          title: "T",
          body: "B",
          state: "open",
          draft: false,
          merged: false,
          head: { sha: "head", ref: "topic" },
          base: { ref: "main" },
          user: { login: "alice", avatar_url: "" },
        });
      if (req.url.endsWith("/user")) return jsonResponse({ login: "alice", avatar_url: "" });
      if (req.url.includes("/pulls/7/comments"))
        return jsonResponse([
          {
            id: 1,
            body: barkBody("c1", "good-sha", "good.md"),
            path: "good.md",
            line: 1,
            user: { login: "alice", avatar_url: "" },
          },
          {
            id: 2,
            body: barkBody("c2", "missing-sha", "missing.md"),
            path: "missing.md",
            line: 1,
            user: { login: "alice", avatar_url: "" },
          },
        ]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      if (req.url.endsWith("/graphql"))
        return jsonResponse({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        });
      if (req.url.includes("missing.md")) return jsonResponse({}, 404);
      if (req.url.includes("/contents/"))
        return jsonResponse({ content: btoa("ok"), encoding: "base64" });
      throw new Error(`unexpected: ${req.url}`);
    });

    const out = await fetchRemoteState({ token: "t", fetch }, PR);
    // good.md survives; missing.md silently drops out — its comment will
    // re-anchor to 'outdated' downstream.
    expect(out.fileContents.map((f) => f.path)).toEqual(["good.md"]);
  });
});
