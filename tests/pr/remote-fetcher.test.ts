import { describe, expect, test } from "bun:test";
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
import type { PrRef } from "../../lib/pr/types";

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
        head: { sha: "headsha", ref: "topic", repo: { name: "r", owner: { login: "o" } } },
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
      headRepo: { owner: "o", repo: "r" },
      baseRef: "main",
      state: "open",
      draft: false,
      merged: false,
      author: { login: "alice", avatarUrl: "https://avatar/a" },
    });
  });
});

describe("remote-fetcher — fork PRs (issue #273)", () => {
  const pullJson = (repo: unknown) => ({
    number: 7,
    title: "T",
    body: "B",
    state: "open",
    draft: false,
    merged: false,
    head: { sha: "h", ref: "topic", repo },
    base: { ref: "main" },
    user: { login: "alice", avatar_url: "" },
  });

  test("a fork PR maps head.repo to headRepo", async () => {
    const { fetch } = makeFetch(async () =>
      jsonResponse(pullJson({ name: "r-fork", owner: { login: "forker" } })),
    );
    const out = await fetchPullRequest({ token: "t", fetch }, PR);
    expect(out.headRepo).toEqual({ owner: "forker", repo: "r-fork" });
  });

  test("a deleted fork yields headRepo null", async () => {
    const { fetch } = makeFetch(async () => jsonResponse(pullJson(null)));
    const out = await fetchPullRequest({ token: "t", fetch }, PR);
    expect(out.headRepo).toBeNull();
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
      remoteKind: "review",
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

describe("remote-fetcher — remoteKind (issue #285)", () => {
  const barkBody = (cid: string) =>
    embedMetadata("text", {
      cid,
      threadId: "t1",
      path: "src/x.md",
      anchor: { sha: "h0", range: { sl: 1, sc: 1, el: 1, ec: 2 }, quote: "q" },
    });

  test("a fetched review comment carries remoteKind 'review'", async () => {
    const { fetch } = makeFetch(async (req) => {
      if (req.url.includes("/pulls/7/comments"))
        return jsonResponse([
          {
            id: 100,
            body: barkBody("bark-review"),
            path: "src/x.md",
            line: 1,
            user: { login: "alice", avatar_url: "" },
          },
          {
            id: 101,
            body: "foreign",
            path: "src/x.md",
            line: 2,
            user: { login: "carol", avatar_url: "" },
          },
        ]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      throw new Error(`unexpected: ${req.url}`);
    });
    const out = await fetchComments({ token: "t", fetch }, PR);
    expect(out.map((c) => c.remoteKind)).toEqual(["review", "review"]);
  });

  test("a fetched issue comment carries remoteKind 'issue'", async () => {
    const { fetch } = makeFetch(async (req) => {
      if (req.url.includes("/pulls/7/comments")) return jsonResponse([]);
      if (req.url.includes("/issues/7/comments"))
        return jsonResponse([
          { id: 50, body: barkBody("bark-issue"), user: { login: "alice", avatar_url: "" } },
          { id: 51, body: "Just a comment", user: { login: "dan", avatar_url: "" } },
        ]);
      throw new Error(`unexpected: ${req.url}`);
    });
    const out = await fetchComments({ token: "t", fetch }, PR);
    expect(out.map((c) => c.remoteKind)).toEqual(["issue", "issue"]);
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
    // The map (built from the thread data) carries the thread's LOCAL id.
    const map = new Map<number, string>([
      [10, "foreign-thread-PRT_shared"],
      [11, "foreign-thread-PRT_shared"],
    ]);
    const out = normalizeComments([foreignReview(10), foreignReview(11, 10)], [], map);
    expect(out[0]?.threadId).toBe("foreign-thread-PRT_shared");
    expect(out[1]?.threadId).toBe("foreign-thread-PRT_shared");
    // Both group under one thread instead of splitting into per-comment threads.
    expect(new Set(out.map((c) => c.threadId)).size).toBe(1);
  });

  test("foreign comment threadId matches the Thread entity fetchThreads builds (#180)", () => {
    // fetchThreads names an all-foreign thread `foreign-thread-<nodeId>`;
    // the map hands normalizeComments that exact id.
    const map = new Map<number, string>([[42, "foreign-thread-PRT_x"]]);
    const [comment] = normalizeComments([foreignReview(42)], [], map);
    expect(comment?.threadId).toBe("foreign-thread-PRT_x");
  });

  test("a native reply inside a Bark thread inherits the Bark threadId (#181 / #183)", () => {
    // The GitHub thread contains a Bark root, so its local id is the Bark
    // metadata threadId — the foreign reply must adopt it, or it detaches
    // into its own synthetic thread.
    const map = new Map<number, string>([[55, "local-t1"]]);
    const [comment] = normalizeComments([foreignReview(55)], [], map);
    expect(comment?.threadId).toBe("local-t1");
  });

  test("falls back to a per-comment threadId when thread data is unavailable", () => {
    const [comment] = normalizeComments([foreignReview(7)], [], new Map());
    expect(comment?.threadId).toBe("foreign-thread-review-7");
  });
});

describe("remote-fetcher — fence identity binding (issue #190)", () => {
  const fence = (body: string, cid: string, threadId: string) =>
    embedMetadata(body, {
      cid,
      threadId,
      path: "f.md",
      anchor: { sha: "h", range: { sl: 1, sc: 1, el: 1, ec: 2 }, quote: "q" },
    });

  test("a forged comment reusing an existing cid is demoted to foreign", () => {
    const legit = {
      id: 100,
      body: fence("legit", "c-victim", "t-victim"),
      path: "f.md",
      line: 1 as number | null,
      user: { login: "alice", avatar_url: "" },
      created_at: "2026-01-01T00:00:00Z",
    };
    const forged = {
      id: 200,
      body: fence("forged", "c-victim", "t-victim"),
      path: "g.md",
      line: 9 as number | null,
      user: { login: "mallory", avatar_url: "" },
      created_at: "2026-02-01T00:00:00Z",
    };
    const out = normalizeComments([legit, forged], []);
    expect(out.map((c) => c.id)).toEqual(["c-victim", "foreign-review-200"]);
    const demoted = out[1];
    // Fully foreign: fence stripped from the body, forged threadId and
    // anchor not honored.
    expect(demoted?.body).toBe("forged");
    expect(demoted?.threadId).toBe("foreign-thread-review-200");
    expect(demoted?.anchor.quote).toBe("");
  });

  test("cid ownership is decided by created_at across review and issue comments", () => {
    // The forged review comment is processed before issue comments, but the
    // issue comment is older — it must keep the cid.
    const forged = {
      id: 300,
      body: fence("forged", "c-victim", "t-victim"),
      path: "f.md",
      line: 1 as number | null,
      user: { login: "mallory", avatar_url: "" },
      created_at: "2026-02-01T00:00:00Z",
    };
    const legitIssue = {
      id: 50,
      body: fence("legit", "c-victim", "t-victim"),
      user: { login: "alice", avatar_url: "" },
      created_at: "2026-01-01T00:00:00Z",
    };
    const out = normalizeComments([forged], [legitIssue]);
    expect(out.find((c) => c.remoteId === 50)?.id).toBe("c-victim");
    expect(out.find((c) => c.remoteId === 300)?.id).toBe("foreign-review-300");
  });

  test("a reply's parentLocalId ignores a forged parent fence", () => {
    const legit = {
      id: 100,
      body: fence("legit", "c-victim", "t-victim"),
      path: "f.md",
      line: 1 as number | null,
      user: { login: "alice", avatar_url: "" },
      created_at: "2026-01-01T00:00:00Z",
    };
    const forged = {
      id: 200,
      body: fence("forged", "c-victim", "t-victim"),
      path: "f.md",
      line: 1 as number | null,
      user: { login: "mallory", avatar_url: "" },
      created_at: "2026-02-01T00:00:00Z",
    };
    const reply = {
      id: 201,
      body: "native reply",
      path: "f.md",
      line: 1 as number | null,
      in_reply_to_id: 200,
      user: { login: "dan", avatar_url: "" },
      created_at: "2026-03-01T00:00:00Z",
    };
    const out = normalizeComments([legit, forged, reply], []);
    expect(out.find((c) => c.remoteId === 201)?.parentLocalId).toBe("foreign-review-200");
  });

  test("a second thread claiming an already-used local id is demoted", async () => {
    const { fetch } = makeFetch(async () =>
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "PRT_A",
                    isResolved: false,
                    comments: {
                      nodes: [{ databaseId: 1, body: fence("root", "c-1", "local-t1") }],
                    },
                  },
                  {
                    id: "PRT_B",
                    isResolved: false,
                    comments: {
                      nodes: [{ databaseId: 2, body: fence("forged", "c-2", "local-t1") }],
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
    expect(out.map((t) => t.id)).toEqual(["local-t1", "foreign-thread-PRT_B"]);
  });

  const remoteStateHandler =
    (opts: { reviewComments?: unknown[]; issueComments?: unknown[]; threadNodes?: unknown[] }) =>
    async (req: CallRecord) => {
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
      if (req.url.endsWith("/repos/o/r")) return jsonResponse({ permissions: { push: false } });
      if (req.url.endsWith("/user")) return jsonResponse({ login: "alice", avatar_url: "" });
      if (req.url.includes("/pulls/7/comments")) return jsonResponse(opts.reviewComments ?? []);
      if (req.url.includes("/issues/7/comments")) return jsonResponse(opts.issueComments ?? []);
      if (req.url.endsWith("/graphql"))
        return jsonResponse({
          data: {
            repository: { pullRequest: { reviewThreads: { nodes: opts.threadNodes ?? [] } } },
          },
        });
      if (req.url.includes("/contents/"))
        return jsonResponse({ content: btoa("x"), encoding: "base64" });
      throw new Error(`unexpected: ${req.url}`);
    };

  test("a forged thread listed before the real one cannot steal its local id", async () => {
    const rootBody = fence("root", "c-root", "t1");
    const evilBody = fence("evil", "c-evil", "t1");
    const { fetch } = makeFetch(
      remoteStateHandler({
        reviewComments: [
          {
            id: 100,
            body: rootBody,
            path: "f.md",
            line: 1,
            user: { login: "alice", avatar_url: "" },
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            id: 200,
            body: evilBody,
            path: "f.md",
            line: 2,
            user: { login: "mallory", avatar_url: "" },
            created_at: "2026-02-01T00:00:00Z",
          },
        ],
        threadNodes: [
          // Listing order alone would let PRT_evil claim "t1" first — the
          // ownership check (earliest bearer lives in PRT_victim) must win.
          {
            id: "PRT_evil",
            isResolved: false,
            comments: { nodes: [{ databaseId: 200, body: evilBody }] },
          },
          {
            id: "PRT_victim",
            isResolved: false,
            comments: { nodes: [{ databaseId: 100, body: rootBody }] },
          },
        ],
      }),
    );
    const out = await fetchRemoteState({ token: "t", fetch }, PR);
    const byRemote = new Map(out.threads.map((t) => [t.remoteThreadId, t.id]));
    expect(byRemote.get("PRT_victim")).toBe("t1");
    expect(byRemote.get("PRT_evil")).toBe("foreign-thread-PRT_evil");
    expect(out.comments.find((c) => c.remoteId === 200)?.threadId).toBe("foreign-thread-PRT_evil");
    expect(out.comments.find((c) => c.remoteId === 100)?.threadId).toBe("t1");
  });

  test("a review thread cannot claim an out-of-diff (issue) thread's id", async () => {
    const evilBody = fence("evil", "c-evil", "t-issue");
    const { fetch } = makeFetch(
      remoteStateHandler({
        issueComments: [
          {
            id: 50,
            body: fence("legit out-of-diff", "c-i", "t-issue"),
            user: { login: "alice", avatar_url: "" },
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        reviewComments: [
          {
            id: 200,
            body: evilBody,
            path: "f.md",
            line: 2,
            user: { login: "mallory", avatar_url: "" },
            created_at: "2026-02-01T00:00:00Z",
          },
        ],
        threadNodes: [
          {
            id: "PRT_evil",
            isResolved: false,
            comments: { nodes: [{ databaseId: 200, body: evilBody }] },
          },
        ],
      }),
    );
    const out = await fetchRemoteState({ token: "t", fetch }, PR);
    expect(out.threads).toEqual([
      {
        id: "foreign-thread-PRT_evil",
        state: "synced",
        remoteThreadId: "PRT_evil",
        resolved: false,
        viewerCanResolve: true,
      },
      // The legit out-of-diff thread keeps its id and gets its own Thread
      // rooted in the owning issue comment (issue #270).
      {
        id: "t-issue",
        state: "synced",
        remoteIssueCommentId: 50,
        resolved: false,
        viewerCanResolve: true,
      },
    ]);
    expect(out.comments.find((c) => c.remoteId === 200)?.threadId).toBe("foreign-thread-PRT_evil");
    expect(out.comments.find((c) => c.remoteId === 50)?.threadId).toBe("t-issue");
  });

  test("an out-of-diff reply keeps the review thread's threadId (#184 flow unaffected)", async () => {
    const rootBody = fence("root", "c-root", "t1");
    const { fetch } = makeFetch(
      remoteStateHandler({
        reviewComments: [
          {
            id: 100,
            body: rootBody,
            path: "f.md",
            line: 1,
            user: { login: "alice", avatar_url: "" },
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        issueComments: [
          {
            id: 60,
            body: fence("reply from another user", "c-reply", "t1"),
            user: { login: "bob", avatar_url: "" },
            created_at: "2026-01-02T00:00:00Z",
          },
        ],
        threadNodes: [
          {
            id: "PRT_A",
            isResolved: false,
            comments: { nodes: [{ databaseId: 100, body: rootBody }] },
          },
        ],
      }),
    );
    const out = await fetchRemoteState({ token: "t", fetch }, PR);
    const reply = out.comments.find((c) => c.remoteId === 60);
    expect(reply?.id).toBe("c-reply");
    expect(reply?.threadId).toBe("t1");
    expect(out.threads.map((t) => t.id)).toEqual(["t1"]);
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

describe("remote-fetcher — fetchFileContent oversized files (issue #292)", () => {
  // GitHub's contents endpoint answers a 1-100 MB file with an empty body and
  // `encoding: "none"`. Decoding that yields "", which would open an empty
  // editor and let a commit replace the file with whatever was typed there.
  const oversized = { content: "", encoding: "none", size: 2_000_000 };

  test("throws instead of decoding to an empty document", async () => {
    const { fetch } = makeFetch(async () => jsonResponse(oversized));
    const promise = fetchFileContent({ token: "t", fetch }, PR, "abc", "big.md");
    await expect(promise).rejects.toThrow(/big\.md/);
    await expect(promise).rejects.toThrow(/too large/i);
  });

  test("fetchRemoteState stores no FileContent for the oversized path", async () => {
    const { fetch } = makeFetch(async (req) => {
      if (req.url.includes("/contents/")) return jsonResponse(oversized);
      if (req.url.endsWith("/pulls/7")) {
        return jsonResponse({
          number: 7,
          title: "T",
          body: "B",
          state: "open",
          draft: false,
          merged: false,
          head: { sha: "h0", ref: "topic" },
          base: { ref: "main" },
          user: { login: "alice", avatar_url: "" },
        });
      }
      if (req.url.endsWith("/user")) return jsonResponse({ login: "alice", avatar_url: "" });
      if (req.url.endsWith("/graphql")) {
        return jsonResponse({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        });
      }
      return jsonResponse([]);
    });
    const out = await fetchRemoteState({ token: "t", fetch }, PR, {
      fileContentTargets: [{ sha: "h0", path: "big.md" }],
    });
    expect(out.fileContents).toEqual([]);
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
      if (req.url.endsWith("/repos/o/r")) return jsonResponse({ permissions: { push: false } });
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

  test("a known viewer skips the /user fetch (ADR 0005 §2: fetched once at bootstrap)", async () => {
    let viewerCalled = false;
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
      if (req.url.endsWith("/repos/o/r")) return jsonResponse({ permissions: { push: false } });
      if (req.url.endsWith("/user")) {
        viewerCalled = true;
        return jsonResponse({ login: "alice", avatar_url: "" });
      }
      if (req.url.includes("/pulls/7/comments")) return jsonResponse([]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      if (req.url.endsWith("/graphql"))
        return jsonResponse({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        });
      throw new Error(`unexpected: ${req.url}`);
    });
    const out = await fetchRemoteState({ token: "t", fetch }, PR, {
      viewer: { login: "cached", avatarUrl: "" },
    });
    expect(viewerCalled).toBe(false);
    expect(out.viewer?.login).toBe("cached");
  });

  test("a native reply in a mixed thread adopts the Bark threadId end-to-end (#181 / #183)", async () => {
    // GitHub thread: Bark root (metadata threadId "local-t1") + a foreign
    // reply. The Thread entity takes the Bark id; the foreign reply's
    // Comment.threadId must equal it, so the thread renders as one group.
    const barkBody = embedMetadata("root", {
      cid: "c-root",
      threadId: "local-t1",
      path: "f.md",
      anchor: { sha: "h", range: { sl: 3, sc: 1, el: 3, ec: 5 }, quote: "sel" },
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
          head: { sha: "h", ref: "topic" },
          base: { ref: "main" },
          user: { login: "alice", avatar_url: "" },
        });
      if (req.url.endsWith("/repos/o/r")) return jsonResponse({ permissions: { push: false } });
      if (req.url.endsWith("/user")) return jsonResponse({ login: "alice", avatar_url: "" });
      if (req.url.includes("/pulls/7/comments"))
        return jsonResponse([
          {
            id: 100,
            body: barkBody,
            path: "f.md",
            line: 3,
            user: { login: "alice", avatar_url: "" },
          },
          {
            id: 101,
            body: "native reply",
            path: "f.md",
            line: 3,
            in_reply_to_id: 100,
            user: { login: "carol", avatar_url: "" },
          },
        ]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      if (req.url.endsWith("/graphql"))
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRT_mixed",
                      isResolved: false,
                      comments: {
                        nodes: [
                          { databaseId: 100, body: barkBody },
                          { databaseId: 101, body: "native reply" },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      if (req.url.includes("/contents/"))
        return jsonResponse({ content: btoa("x"), encoding: "base64" });
      throw new Error(`unexpected: ${req.url}`);
    });
    const out = await fetchRemoteState({ token: "t", fetch }, PR);
    const reply = out.comments.find((c) => c.remoteId === 101);
    expect(reply?.threadId).toBe("local-t1");
    expect(reply?.parentLocalId).toBe("c-root");
    expect(out.threads).toEqual([
      {
        id: "local-t1",
        state: "synced",
        remoteThreadId: "PRT_mixed",
        resolved: false,
        viewerCanResolve: true,
      },
    ]);
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
      if (req.url.endsWith("/repos/o/r")) return jsonResponse({ permissions: { push: false } });
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
      // plus each anchored path at the head, for the re-anchoring map
      "h:a.md:hello",
      "h:b.md:hello",
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
      if (req.url.endsWith("/repos/o/r")) return jsonResponse({ permissions: { push: false } });
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
    // entirely on its own (plus the head version of that path).
    expect(out.fileContents.map((f) => `${f.sha}:${f.path}:${f.source}`)).toEqual([
      "old-sha:src/x.md:hello world",
      "head:src/x.md:hello world",
    ]);
    expect(contentsCalls).toHaveLength(2);
  });

  // Issue #279: a quote over the cap travels as an excerpt plus digest and
  // length. It is content-addressed by (anchor.sha, path, range), so the
  // fetcher restores it from the FileContent it already fetched.
  describe("capped quote restoration", () => {
    const LONG = "w".repeat(3000);
    const barkBody = embedMetadata("hi", {
      cid: "c1",
      threadId: "t1",
      path: "docs/a.md",
      anchor: { sha: "old", range: { sl: 1, sc: 1, el: 1, ec: 3001 }, quote: LONG },
    });
    const fetchWithLine = (line: string) =>
      makeFetch(async (req) => {
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
              path: "docs/a.md",
              line: 1,
              user: { login: "alice", avatar_url: "" },
            },
          ]);
        if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
        if (req.url.endsWith("/graphql"))
          return jsonResponse({
            data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
          });
        if (req.url.includes("/contents/"))
          return jsonResponse({ content: btoa(line), encoding: "base64" });
        throw new Error(`unexpected: ${req.url}`);
      }).fetch;

    test("the full quote is restored from the anchor-sha file content", async () => {
      const out = await fetchRemoteState({ token: "t", fetch: fetchWithLine(LONG) }, PR);
      expect(out.comments[0]?.anchor.quote).toBe(LONG);
    });

    test("a digest mismatch keeps the excerpt rather than a wrong quote", async () => {
      const out = await fetchRemoteState(
        { token: "t", fetch: fetchWithLine("v".repeat(3000)) },
        PR,
      );
      expect(out.comments[0]?.anchor.quote.length).toBe(1000);
    });
  });

  test("the head-sha version of every anchored path is fetched too (issue #265)", async () => {
    // Re-anchoring (display and posting) maps anchor.sha → headSha, which
    // needs the head-sha source as well as the anchor-sha one; nothing
    // else fetches it, so the orchestrator must.
    const contentsRefs: string[] = [];
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
      if (req.url.endsWith("/repos/o/r")) return jsonResponse({ permissions: { push: false } });
      if (req.url.endsWith("/user")) return jsonResponse({ login: "alice", avatar_url: "" });
      if (req.url.includes("/pulls/7/comments")) return jsonResponse([]);
      if (req.url.includes("/issues/7/comments")) return jsonResponse([]);
      if (req.url.endsWith("/graphql"))
        return jsonResponse({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        });
      if (req.url.includes("/contents/")) {
        contentsRefs.push(new URL(req.url).searchParams.get("ref") ?? "");
        return jsonResponse({ content: btoa("x"), encoding: "base64" });
      }
      throw new Error(`unexpected: ${req.url}`);
    });

    const out = await fetchRemoteState({ token: "t", fetch }, PR, {
      fileContentTargets: [{ sha: "old", path: "x.md" }],
    });

    expect(contentsRefs.sort()).toEqual(["head", "old"]);
    expect(out.fileContents.map((f) => `${f.sha}:${f.path}`).sort()).toEqual([
      "head:x.md",
      "old:x.md",
    ]);
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
      if (req.url.endsWith("/repos/o/r")) return jsonResponse({ permissions: { push: false } });
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
    // old:x.md once (deduped) + head:x.md
    expect(out.fileContents).toHaveLength(2);
    expect(contentsCalls).toHaveLength(2);
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
      if (req.url.endsWith("/repos/o/r")) return jsonResponse({ permissions: { push: false } });
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
    // good.md survives (anchor sha + head); missing.md silently drops out —
    // its comment will re-anchor to 'outdated' downstream.
    expect(out.fileContents.map((f) => `${f.sha}:${f.path}`)).toEqual([
      "good-sha:good.md",
      "head:good.md",
    ]);
  });
});

const ANCHOR = { sha: "h", range: { sl: 1, sc: 1, el: 1, ec: 2 }, quote: "x" };

const outOfDiffBody = (cid: string, threadId: string, resolved?: boolean) =>
  embedMetadata(cid, {
    cid,
    threadId,
    path: "f.md",
    anchor: ANCHOR,
    ...(resolved === undefined ? {} : { resolved }),
  });

const issueComment = (id: number, createdAt: string, body: string, author = "alice") => ({
  id,
  created_at: createdAt,
  body,
  user: { login: author, avatar_url: "" },
});

function stateFetch(opts: {
  review?: unknown[];
  issue?: unknown[];
  reviewThreads?: unknown[];
  /** Authenticated user; defaults to the PR author alice. */
  viewer?: string;
  /** `permissions.push` on GET /repos/o/r; omitted → the probe 403s. */
  push?: boolean;
  prAuthor?: string;
}): typeof fetch {
  return makeFetch(async (req) => {
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
        user: { login: opts.prAuthor ?? "alice", avatar_url: "" },
      });
    if (req.url.endsWith("/repos/o/r"))
      return opts.push === undefined
        ? jsonResponse({ message: "Forbidden" }, 403)
        : jsonResponse({ permissions: { push: opts.push } });
    if (req.url.endsWith("/user"))
      return jsonResponse({ login: opts.viewer ?? "alice", avatar_url: "" });
    if (req.url.includes("/pulls/7/comments")) return jsonResponse(opts.review ?? []);
    if (req.url.includes("/issues/7/comments")) return jsonResponse(opts.issue ?? []);
    if (req.url.endsWith("/graphql"))
      return jsonResponse({
        data: {
          repository: { pullRequest: { reviewThreads: { nodes: opts.reviewThreads ?? [] } } },
        },
      });
    if (req.url.includes("/contents/"))
      return jsonResponse({ content: btoa("x"), encoding: "base64" });
    throw new Error(`unexpected: ${req.url}`);
  }).fetch;
}

describe("remote-fetcher — out-of-diff Threads (issue #270)", () => {
  test("fetchRemoteState synthesises a Thread for a Bark out-of-diff thread from its root fence", async () => {
    const fetch = stateFetch({
      issue: [
        issueComment(501, "2026-01-01T00:00:00Z", outOfDiffBody("c-root", "t-out", true)),
        issueComment(502, "2026-01-02T00:00:00Z", outOfDiffBody("c-reply", "t-out")),
        issueComment(503, "2026-01-03T00:00:00Z", outOfDiffBody("c-open", "t-open")),
      ],
    });
    const state = await fetchRemoteState({ token: "t", fetch }, PR);
    expect(state.threads).toEqual([
      {
        id: "t-out",
        state: "synced",
        remoteIssueCommentId: 501,
        resolved: true,
        viewerCanResolve: true,
      },
      {
        id: "t-open",
        state: "synced",
        remoteIssueCommentId: 503,
        resolved: false,
        viewerCanResolve: true,
      },
    ]);
    expect(state.comments.map((c) => c.threadId)).toEqual(["t-out", "t-out", "t-open"]);
  });

  test("resolved is read only from the thread's root; a later comment reusing the threadId cannot resolve it (issue #190)", async () => {
    const fetch = stateFetch({
      issue: [
        issueComment(501, "2026-01-01T00:00:00Z", outOfDiffBody("c-root", "t-out")),
        issueComment(504, "2026-01-04T00:00:00Z", outOfDiffBody("c-forged", "t-out", true)),
      ],
    });
    const state = await fetchRemoteState({ token: "t", fetch }, PR);
    expect(state.threads).toEqual([
      {
        id: "t-out",
        state: "synced",
        remoteIssueCommentId: 501,
        resolved: false,
        viewerCanResolve: true,
      },
    ]);
  });

  test("an out-of-diff reply to a review thread does not create a second Thread (#184 flow)", async () => {
    const rootBody = outOfDiffBody("c-in", "t-in");
    const fetch = stateFetch({
      review: [
        {
          id: 100,
          created_at: "2026-01-01T00:00:00Z",
          body: rootBody,
          path: "f.md",
          line: 1,
          user: { login: "alice", avatar_url: "" },
        },
      ],
      issue: [issueComment(505, "2026-01-02T00:00:00Z", outOfDiffBody("c-out", "t-in", true))],
      reviewThreads: [
        {
          id: "PRT_1",
          isResolved: false,
          comments: { nodes: [{ databaseId: 100, body: rootBody }] },
        },
      ],
    });
    const state = await fetchRemoteState({ token: "t", fetch }, PR);
    expect(state.threads).toEqual([
      {
        id: "t-in",
        state: "synced",
        remoteThreadId: "PRT_1",
        resolved: false,
        viewerCanResolve: true,
      },
    ]);
  });

  test("an issue fence claiming a review thread's synthesised id does not duplicate the Thread (issue #190)", async () => {
    const fetch = stateFetch({
      review: [
        {
          id: 100,
          created_at: "2026-01-01T00:00:00Z",
          body: "native comment",
          path: "f.md",
          line: 1,
          user: { login: "carol", avatar_url: "" },
        },
      ],
      issue: [
        issueComment(
          506,
          "2026-01-02T00:00:00Z",
          outOfDiffBody("c-forged", "foreign-thread-PRT_1", true),
        ),
      ],
      reviewThreads: [
        {
          id: "PRT_1",
          isResolved: false,
          comments: { nodes: [{ databaseId: 100, body: "native comment" }] },
        },
      ],
    });
    const state = await fetchRemoteState({ token: "t", fetch }, PR);
    expect(state.threads).toEqual([
      {
        id: "foreign-thread-PRT_1",
        state: "synced",
        remoteThreadId: "PRT_1",
        resolved: false,
        viewerCanResolve: true,
      },
    ]);
  });
});

describe("remote-fetcher — viewerCanResolve (issue #274)", () => {
  const reviewThreads = [
    {
      id: "PRT_1",
      isResolved: false,
      comments: { nodes: [{ databaseId: 100, body: "native comment" }] },
    },
  ];

  const canResolveReviewThread = async (opts: Parameters<typeof stateFetch>[0]) => {
    const state = await fetchRemoteState({ token: "t", fetch: stateFetch(opts) }, PR);
    return state.threads[0]?.viewerCanResolve;
  };

  test("a read-only reviewer cannot resolve a review thread", async () => {
    expect(
      await canResolveReviewThread({
        reviewThreads,
        viewer: "bob",
        prAuthor: "alice",
        push: false,
      }),
    ).toBe(false);
  });

  test("write access can resolve a review thread", async () => {
    expect(
      await canResolveReviewThread({ reviewThreads, viewer: "bob", prAuthor: "alice", push: true }),
    ).toBe(true);
  });

  test("the PR author can resolve a review thread without write access", async () => {
    expect(
      await canResolveReviewThread({
        reviewThreads,
        viewer: "Alice",
        prAuthor: "alice",
        push: false,
      }),
    ).toBe(true);
  });

  test("an out-of-diff thread is resolvable by its root comment's author", async () => {
    const byBob = await fetchRemoteState(
      {
        token: "t",
        fetch: stateFetch({
          viewer: "bob",
          prAuthor: "alice",
          push: false,
          issue: [issueComment(501, "2026-01-01T00:00:00Z", outOfDiffBody("c1", "t-out"), "bob")],
        }),
      },
      PR,
    );
    expect(byBob.threads[0]?.viewerCanResolve).toBe(true);

    const byAlice = await fetchRemoteState(
      {
        token: "t",
        fetch: stateFetch({
          viewer: "bob",
          prAuthor: "alice",
          push: false,
          issue: [issueComment(502, "2026-01-01T00:00:00Z", outOfDiffBody("c2", "t-out"), "alice")],
        }),
      },
      PR,
    );
    expect(byAlice.threads[0]?.viewerCanResolve).toBe(false);
  });

  test("a failed permission probe defaults to no write access and does not fail the refresh", async () => {
    // `push` omitted → GET /repos/o/r answers 403.
    expect(await canResolveReviewThread({ reviewThreads, viewer: "bob", prAuthor: "alice" })).toBe(
      false,
    );
  });
});
