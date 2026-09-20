import { describe, expect, test } from "bun:test";
import { createGitHubTransport, type PrRef } from "../../lib/pr/github-transport";
import { embedMetadata } from "../../lib/pr/metadata";
import type { Comment } from "../../lib/pr/types";

const PR: PrRef = { owner: "o", repo: "r", number: 7 };
const author = { login: "alice" };
const anchor = {
  sha: "h0",
  range: { sl: 5, sc: 1, el: 5, ec: 10 },
  quote: "hello",
};

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    state: "syncing",
    threadId: "t1",
    body: "Looks off",
    author,
    path: "f.md",
    anchor,
    ...overrides,
  };
}

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

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("github-transport — postReviewBatch", () => {
  test("posts a review, then resolves cid mappings via GraphQL", async () => {
    const c = comment();
    const postedBody = embedMetadata(c.body, {
      cid: c.id,
      threadId: c.threadId,
      path: c.path,
      anchor: c.anchor,
    });
    const { fetch, calls } = makeFetch(async (req) => {
      if (req.url.endsWith("/pulls/7/reviews")) {
        return jsonResponse({ id: 999 });
      }
      if (req.url.endsWith("/graphql")) {
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRT_kw_new",
                      isResolved: false,
                      comments: {
                        nodes: [{ databaseId: 12345, body: postedBody }],
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      }
      throw new Error(`unexpected call: ${req.url}`);
    });
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.postReviewBatch({
      kind: "post-review-batch",
      commitId: "h0",
      comments: [c],
    });
    expect(outcome).toEqual({
      ok: true,
      mappings: [{ cid: "c1", remoteId: 12345, remoteThreadId: "PRT_kw_new" }],
    });
    // Verify the review POST included the embedded metadata.
    const reviewCall = calls.find((c) => c.url.endsWith("/pulls/7/reviews"));
    expect(reviewCall?.body).toContain("bark:v2");
  });

  test("re-lists with backoff while a posted cid is still missing (read-after-write lag, issue #266 path A)", async () => {
    const c = comment();
    const postedBody = embedMetadata(c.body, {
      cid: c.id,
      threadId: c.threadId,
      path: c.path,
      anchor: c.anchor,
    });
    const threadsResponse = (nodes: unknown[]) =>
      jsonResponse({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });
    let listings = 0;
    const { fetch } = makeFetch(async (req) => {
      if (req.url.endsWith("/pulls/7/reviews")) return jsonResponse({ id: 999 });
      listings++;
      if (listings < 3) return threadsResponse([]);
      return threadsResponse([
        {
          id: "PRT_late",
          isResolved: false,
          comments: { nodes: [{ databaseId: 5, body: postedBody }] },
        },
      ]);
    });
    const delays: number[] = [];
    const transport = createGitHubTransport(
      { token: "t", fetch, delay: async (ms) => void delays.push(ms) },
      PR,
    );
    const outcome = await transport.postReviewBatch({
      kind: "post-review-batch",
      commitId: "h0",
      comments: [c],
    });
    expect(outcome).toEqual({
      ok: true,
      mappings: [{ cid: "c1", remoteId: 5, remoteThreadId: "PRT_late" }],
    });
    expect(listings).toBe(3);
    expect(delays).toHaveLength(2);
  });

  test("gives up re-listing after a bound and reports the cid as unmapped", async () => {
    const threadsResponse = jsonResponse({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });
    let listings = 0;
    const { fetch } = makeFetch(async (req) => {
      if (req.url.endsWith("/pulls/7/reviews")) return jsonResponse({ id: 999 });
      listings++;
      return threadsResponse;
    });
    const transport = createGitHubTransport({ token: "t", fetch, delay: async () => {} }, PR);
    const outcome = await transport.postReviewBatch({
      kind: "post-review-batch",
      commitId: "h0",
      comments: [comment()],
    });
    expect(outcome).toEqual({ ok: true, mappings: [] });
    expect(listings).toBeLessThanOrEqual(5);
  });

  test("reports ok: true with confirmError when the listing fails after a successful POST (issue #266 path B)", async () => {
    const { fetch, calls } = makeFetch(async (req) => {
      if (req.url.endsWith("/pulls/7/reviews")) return jsonResponse({ id: 999 });
      throw new TypeError("network down");
    });
    // Zero backoff so the listing's transient-error retries don't slow the test.
    const transport = createGitHubTransport({ token: "t", fetch, delay: async () => {} }, PR);
    const outcome = await transport.postReviewBatch({
      kind: "post-review-batch",
      commitId: "h0",
      comments: [comment()],
    });
    // The review was created; reporting ok: false would make the Executor
    // revert to plain draft and the next submit would post it again.
    expect(calls.filter((c) => c.url.endsWith("/pulls/7/reviews"))).toHaveLength(1);
    expect(outcome).toEqual({
      ok: true,
      mappings: [],
      confirmError: expect.objectContaining({ message: "network down" }),
    });
  });

  test("returns ok: false on 422 from the review POST", async () => {
    const { fetch } = makeFetch(async () => {
      const resp = {
        ok: false,
        status: 422,
        text: async () => "unprocessable",
      } as unknown as Response;
      return resp;
    });
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.postReviewBatch({
      kind: "post-review-batch",
      commitId: "h0",
      comments: [comment()],
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe(422);
    }
  });
});

describe("github-transport — postReply", () => {
  test("POSTs to /pulls/n/comments/{parent}/replies with embedded metadata", async () => {
    const parent = comment({ id: "p", state: "synced", remoteId: 101 });
    const reply = comment({ id: "r", parentLocalId: "p" });
    const { fetch, calls } = makeFetch(async () => jsonResponse({ id: 222 }));
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.postReply({
      kind: "post-reply",
      comment: reply,
      parent,
    });
    expect(outcome).toEqual({ ok: true, mapping: { cid: "r", remoteId: 222 } });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/pulls/7/comments/101/replies");
    expect(calls[0]?.body).toContain("bark:v2");
  });

  test("returns ok: false when parent is missing remoteId", async () => {
    const parent = comment({ id: "p", state: "syncing" });
    const reply = comment({ id: "r", parentLocalId: "p" });
    const { fetch } = makeFetch(async () => jsonResponse({}));
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.postReply({
      kind: "post-reply",
      comment: reply,
      parent,
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("github-transport — postIssueComment", () => {
  test("POSTs to /issues/n/comments with embedded metadata", async () => {
    const { fetch, calls } = makeFetch(async () => jsonResponse({ id: 555 }));
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const c = comment();
    const outcome = await transport.postIssueComment({
      kind: "post-issue-comment",
      comment: c,
    });
    expect(outcome).toEqual({ ok: true, mapping: { cid: "c1", remoteId: 555 } });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/o/r/issues/7/comments");
    expect(calls[0]?.body).toContain("bark:v2");
  });
});

describe("github-transport — Resolve / Unresolve", () => {
  test("resolveReviewThread sends GraphQL mutation with threadId", async () => {
    const { fetch, calls } = makeFetch(async () =>
      jsonResponse({ data: { resolveReviewThread: { thread: { id: "PRT_a" } } } }),
    );
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.resolveReviewThread({
      kind: "resolve-review-thread",
      threadId: "t1",
      remoteThreadId: "PRT_a",
    });
    expect(outcome).toEqual({ ok: true });
    const payload = JSON.parse(calls[0]?.body ?? "{}");
    expect(payload.variables).toEqual({ threadId: "PRT_a" });
    expect(payload.query).toContain("resolveReviewThread");
  });

  test("unresolveReviewThread mirrors the same shape with the unresolve mutation", async () => {
    const { fetch, calls } = makeFetch(async () =>
      jsonResponse({ data: { unresolveReviewThread: { thread: { id: "PRT_a" } } } }),
    );
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.unresolveReviewThread({
      kind: "unresolve-review-thread",
      threadId: "t1",
      remoteThreadId: "PRT_a",
    });
    expect(outcome).toEqual({ ok: true });
    const payload = JSON.parse(calls[0]?.body ?? "{}");
    expect(payload.query).toContain("unresolveReviewThread");
  });
});

describe("github-transport — setIssueThreadResolved (issue #270)", () => {
  const ROOT_URL = "https://api.github.com/repos/o/r/issues/comments/501";
  const step = {
    kind: "set-issue-thread-resolved" as const,
    threadId: "t1",
    issueCommentId: 501,
    resolved: true,
  };

  test("rewrites the root comment's fence in place (GET → PATCH)", async () => {
    const current = embedMetadata("Root text", {
      cid: "c1",
      threadId: "t1",
      path: "f.md",
      anchor,
    });
    const { fetch, calls } = makeFetch(async (req) =>
      req.method === "GET" ? jsonResponse({ body: current }) : jsonResponse({ id: 501 }),
    );
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.setIssueThreadResolved(step);
    expect(outcome).toEqual({ ok: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${ROOT_URL}`,
      `PATCH ${ROOT_URL}`,
    ]);
    expect(JSON.parse(calls[1]?.body ?? "{}").body).toBe(
      embedMetadata("Root text", {
        cid: "c1",
        threadId: "t1",
        path: "f.md",
        anchor,
        resolved: true,
      }),
    );
  });

  test("a root comment without Bark metadata fails without a PATCH", async () => {
    const { fetch, calls } = makeFetch(async () => jsonResponse({ body: "plain comment" }));
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.setIssueThreadResolved(step);
    expect(outcome).toEqual({
      ok: false,
      error: { message: expect.stringContaining("metadata") },
    });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("a 403 on the PATCH is reported as a failed outcome", async () => {
    const current = embedMetadata("Root text", {
      cid: "c1",
      threadId: "t1",
      path: "f.md",
      anchor,
    });
    const { fetch } = makeFetch(async (req) =>
      req.method === "GET"
        ? jsonResponse({ body: current })
        : jsonResponse({ message: "Forbidden" }, 403),
    );
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.setIssueThreadResolved(step);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error.code).toBe(403);
  });

  test("a legacy v1 root fence is upgraded to v2 carrying resolved", async () => {
    const v1 = btoa(
      JSON.stringify({
        cid: "c1",
        thread: "t1",
        path: "f.md",
        sha: anchor.sha,
        quote: anchor.quote,
        range: anchor.range,
      }),
    );
    const { fetch, calls } = makeFetch(async (req) =>
      req.method === "GET"
        ? jsonResponse({ body: `Root text\n\n<!-- bark:v1 ${v1} -->` })
        : jsonResponse({ id: 501 }),
    );
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    expect(await transport.setIssueThreadResolved(step)).toEqual({ ok: true });
    expect(JSON.parse(calls[1]?.body ?? "{}").body).toBe(
      embedMetadata("Root text", {
        cid: "c1",
        threadId: "t1",
        path: "f.md",
        anchor,
        resolved: true,
      }),
    );
  });
});

describe("github-transport — commit", () => {
  test("blobs -> tree -> commit -> updateRef, returns the new head sha", async () => {
    const { fetch, calls } = makeFetch(async (req) => {
      if (req.url.includes("/git/trees/h0")) {
        return jsonResponse({
          tree: [{ path: "a.md", mode: "100644", type: "blob", sha: "blob-old" }],
        });
      }
      if (req.url.endsWith("/git/blobs")) return jsonResponse({ sha: "blob-sha" });
      if (req.url.endsWith("/git/trees")) return jsonResponse({ sha: "tree-sha" });
      if (req.url.endsWith("/git/commits")) return jsonResponse({ sha: "commit-sha" });
      if (req.url.includes("/git/refs/heads/")) return jsonResponse({});
      throw new Error(`unexpected call: ${req.url}`);
    });
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.commit({
      kind: "commit",
      baseSha: "h0",
      headRef: "topic",
      headRepo: { owner: "o", repo: "r" },
      fileEdits: [
        {
          id: "f1",
          state: "syncing",
          path: "a.md",
          baseSha: "h0",
          editedSource: "edited",
        },
      ],
    });
    expect(outcome).toEqual({ ok: true, newHeadSha: "commit-sha" });
    // The base tree is read once (it carries each path's mode), then:
    // blob, tree, commit, updateRef. No second tree read when every
    // FileEdit's baseSha matches the commit base.
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST", "POST", "PATCH"]);
  });

  test("a stale FileEdit whose file changed since its baseSha fails as a conflict (issue #187)", () => {
    const { fetch, calls } = makeFetch(async (req) => {
      // The file's blob differs between the edit's base and the current head.
      if (req.url.includes("/git/trees/h0")) {
        return jsonResponse({
          tree: [{ path: "a.md", mode: "100644", type: "blob", sha: "blob-old" }],
        });
      }
      if (req.url.includes("/git/trees/h1")) {
        return jsonResponse({
          tree: [{ path: "a.md", mode: "100644", type: "blob", sha: "blob-new" }],
        });
      }
      throw new Error(`unexpected call: ${req.url}`);
    });
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    return transport
      .commit({
        kind: "commit",
        baseSha: "h1", // head advanced past the edit's base
        headRef: "topic",
        headRepo: { owner: "o", repo: "r" },
        fileEdits: [
          { id: "f1", state: "syncing", path: "a.md", baseSha: "h0", editedSource: "edited" },
        ],
      })
      .then((outcome) => {
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.error.message).toContain("Conflict: a.md changed");
        // Nothing was committed: only the two tree GETs ran.
        expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
      });
  });

  test("a stale baseSha with an UNCHANGED file commits normally", async () => {
    const { fetch, calls } = makeFetch(async (req) => {
      if (req.url.includes("/git/trees/h0") || req.url.includes("/git/trees/h1")) {
        return jsonResponse({
          tree: [{ path: "a.md", mode: "100644", type: "blob", sha: "blob-same" }],
        });
      }
      if (req.url.endsWith("/git/blobs")) return jsonResponse({ sha: "blob-sha" });
      if (req.url.endsWith("/git/trees")) return jsonResponse({ sha: "tree-sha" });
      if (req.url.endsWith("/git/commits")) return jsonResponse({ sha: "commit-sha" });
      if (req.url.includes("/git/refs/heads/")) return jsonResponse({});
      throw new Error(`unexpected call: ${req.url}`);
    });
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.commit({
      kind: "commit",
      baseSha: "h1",
      headRef: "topic",
      headRepo: { owner: "o", repo: "r" },
      fileEdits: [
        { id: "f1", state: "syncing", path: "a.md", baseSha: "h0", editedSource: "edited" },
      ],
    });
    expect(outcome).toEqual({ ok: true, newHeadSha: "commit-sha" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST", "POST", "POST", "PATCH"]);
  });

  test("a file deleted at the head also fails as a conflict", async () => {
    const { fetch } = makeFetch(async (req) => {
      if (req.url.includes("/git/trees/h0")) {
        return jsonResponse({
          tree: [{ path: "a.md", mode: "100644", type: "blob", sha: "blob-old" }],
        });
      }
      // a.md is gone at the head.
      if (req.url.includes("/git/trees/h1")) return jsonResponse({ tree: [] });
      throw new Error(`unexpected call: ${req.url}`);
    });
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.commit({
      kind: "commit",
      baseSha: "h1",
      headRef: "topic",
      headRepo: { owner: "o", repo: "r" },
      fileEdits: [
        { id: "f1", state: "syncing", path: "a.md", baseSha: "h0", editedSource: "edited" },
      ],
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toContain("Conflict: a.md changed");
  });

  test("an executable file keeps its 100755 mode in the new tree (issue #292)", async () => {
    const { fetch, calls } = makeFetch(async (req) => {
      if (req.url.includes("/git/trees/h0")) {
        return jsonResponse({
          tree: [
            { path: "a.md", mode: "100755", type: "blob", sha: "blob-old" },
            { path: "b.md", mode: "100644", type: "blob", sha: "blob-b" },
          ],
        });
      }
      if (req.url.endsWith("/git/blobs")) return jsonResponse({ sha: "blob-sha" });
      if (req.url.endsWith("/git/trees")) return jsonResponse({ sha: "tree-sha" });
      if (req.url.endsWith("/git/commits")) return jsonResponse({ sha: "commit-sha" });
      if (req.url.includes("/git/refs/heads/")) return jsonResponse({});
      throw new Error(`unexpected call: ${req.url}`);
    });
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.commit({
      kind: "commit",
      baseSha: "h0",
      headRef: "topic",
      headRepo: { owner: "o", repo: "r" },
      fileEdits: [
        { id: "f1", state: "syncing", path: "a.md", baseSha: "h0", editedSource: "edited" },
      ],
    });
    expect(outcome).toEqual({ ok: true, newHeadSha: "commit-sha" });
    const createTree = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/trees"));
    expect(JSON.parse(createTree?.body ?? "{}").tree).toEqual([
      { path: "a.md", mode: "100755", type: "blob", sha: "blob-sha" },
    ]);
  });

  test("a new file not in the base tree falls back to mode 100644", async () => {
    const { fetch, calls } = makeFetch(async (req) => {
      if (req.url.includes("/git/trees/h0")) return jsonResponse({ tree: [] });
      if (req.url.endsWith("/git/blobs")) return jsonResponse({ sha: "blob-sha" });
      if (req.url.endsWith("/git/trees")) return jsonResponse({ sha: "tree-sha" });
      if (req.url.endsWith("/git/commits")) return jsonResponse({ sha: "commit-sha" });
      if (req.url.includes("/git/refs/heads/")) return jsonResponse({});
      throw new Error(`unexpected call: ${req.url}`);
    });
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    await transport.commit({
      kind: "commit",
      baseSha: "h0",
      headRef: "topic",
      headRepo: { owner: "o", repo: "r" },
      fileEdits: [
        { id: "f1", state: "syncing", path: "new.md", baseSha: "h0", editedSource: "edited" },
      ],
    });
    const createTree = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/trees"));
    expect(JSON.parse(createTree?.body ?? "{}").tree[0].mode).toBe("100644");
  });

  test("the conflict check resolves blob shas for a file over 1 MB (issue #292)", async () => {
    // `/contents` returns no usable sha for a file this big; the Git Trees API
    // does. Any call to `/contents` here means the old path is still in use.
    const { fetch, calls } = makeFetch(async (req) => {
      if (req.url.includes("/contents/")) {
        return jsonResponse({ content: "", encoding: "none", size: 2_000_000 });
      }
      if (req.url.includes("/git/trees/h0") || req.url.includes("/git/trees/h1")) {
        return jsonResponse({
          tree: [{ path: "big.md", mode: "100644", type: "blob", sha: "blob-same" }],
        });
      }
      if (req.url.endsWith("/git/blobs")) return jsonResponse({ sha: "blob-sha" });
      if (req.url.endsWith("/git/trees")) return jsonResponse({ sha: "tree-sha" });
      if (req.url.endsWith("/git/commits")) return jsonResponse({ sha: "commit-sha" });
      if (req.url.includes("/git/refs/heads/")) return jsonResponse({});
      throw new Error(`unexpected call: ${req.url}`);
    });
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.commit({
      kind: "commit",
      baseSha: "h1",
      headRef: "topic",
      headRepo: { owner: "o", repo: "r" },
      fileEdits: [
        { id: "f1", state: "syncing", path: "big.md", baseSha: "h0", editedSource: "edited" },
      ],
    });
    expect(outcome).toEqual({ ok: true, newHeadSha: "commit-sha" });
    expect(calls.some((c) => c.url.includes("/contents/"))).toBe(false);
  });
});

describe("github-transport — commit targets the head repository (issue #273)", () => {
  const FORK = { owner: "forker", repo: "r-fork" };

  const forkStep = (headRepo: { owner: string; repo: string }) => ({
    kind: "commit" as const,
    baseSha: "h1",
    headRef: "topic",
    headRepo,
    fileEdits: [
      { id: "f1", state: "syncing" as const, path: "a.md", baseSha: "h0", editedSource: "edited" },
    ],
  });

  /** The tree the conflict check reads at either sha: a.md unchanged. */
  const unchangedTree = jsonResponse({
    tree: [{ path: "a.md", mode: "100644", type: "blob", sha: "blob-same" }],
  });

  test("Git Data writes go to headRepo while the conflict check reads the base", async () => {
    const { fetch, calls } = makeFetch(async (req) => {
      if (req.url.includes("/git/trees/h0") || req.url.includes("/git/trees/h1"))
        return unchangedTree;
      if (req.url.endsWith("/git/blobs")) return jsonResponse({ sha: "blob-sha" });
      if (req.url.endsWith("/git/trees")) return jsonResponse({ sha: "tree-sha" });
      if (req.url.endsWith("/git/commits")) return jsonResponse({ sha: "commit-sha" });
      if (req.url.includes("/git/refs/heads/")) return jsonResponse({});
      throw new Error(`unexpected call: ${req.url}`);
    });
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.commit(forkStep(FORK));
    expect(outcome).toEqual({ ok: true, newHeadSha: "commit-sha" });
    expect(calls.map((c) => c.url.replace("https://api.github.com", ""))).toEqual([
      "/repos/o/r/git/trees/h1?recursive=1",
      "/repos/o/r/git/trees/h0?recursive=1",
      "/repos/forker/r-fork/git/blobs",
      "/repos/forker/r-fork/git/trees",
      "/repos/forker/r-fork/git/commits",
      "/repos/forker/r-fork/git/refs/heads/topic",
    ]);
  });

  test("a 404 from the fork explains the App-install requirement", async () => {
    const { fetch } = makeFetch(async (req) => {
      if (req.url.includes("/git/trees/h0") || req.url.includes("/git/trees/h1"))
        return unchangedTree;
      if (req.url.endsWith("/git/blobs")) return jsonResponse({ message: "Not Found" }, 404);
      throw new Error(`unexpected call: ${req.url}`);
    });
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.commit(forkStep(FORK));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("Install the Bark GitHub App on that repository");
      expect(outcome.error.code).toBe(404);
    }
  });

  test("a same-repo PR keeps the raw GitHub message", async () => {
    const { fetch } = makeFetch(async (req) => {
      if (req.url.includes("/git/trees/h0") || req.url.includes("/git/trees/h1"))
        return unchangedTree;
      if (req.url.endsWith("/git/blobs")) return jsonResponse({ message: "Not Found" }, 404);
      throw new Error(`unexpected call: ${req.url}`);
    });
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.commit(forkStep({ owner: "o", repo: "r" }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).not.toContain("Install the Bark GitHub App");
    }
  });
});
