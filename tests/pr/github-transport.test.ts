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

describe("github-transport — commit", () => {
  test("blobs -> tree -> commit -> updateRef, returns the new head sha", async () => {
    const { fetch, calls } = makeFetch(async (req) => {
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
    // Exactly: blob, tree, commit, updateRef — no conflict-check GETs when
    // every FileEdit's baseSha matches the commit base.
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST", "POST", "PATCH"]);
  });

  test("a stale FileEdit whose file changed since its baseSha fails as a conflict (issue #187)", () => {
    const { fetch, calls } = makeFetch(async (req) => {
      // The file's blob differs between the edit's base and the current head.
      if (req.url.includes("/contents/a.md?ref=h0")) return jsonResponse({ sha: "blob-old" });
      if (req.url.includes("/contents/a.md?ref=h1")) return jsonResponse({ sha: "blob-new" });
      throw new Error(`unexpected call: ${req.url}`);
    });
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    return transport
      .commit({
        kind: "commit",
        baseSha: "h1", // head advanced past the edit's base
        headRef: "topic",
        fileEdits: [
          { id: "f1", state: "syncing", path: "a.md", baseSha: "h0", editedSource: "edited" },
        ],
      })
      .then((outcome) => {
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.error.message).toContain("Conflict: a.md changed");
        // Nothing was committed: only the two contents GETs ran.
        expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
      });
  });

  test("a stale baseSha with an UNCHANGED file commits normally", async () => {
    const { fetch, calls } = makeFetch(async (req) => {
      if (req.url.includes("/contents/a.md")) return jsonResponse({ sha: "blob-same" });
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
      fileEdits: [
        { id: "f1", state: "syncing", path: "a.md", baseSha: "h0", editedSource: "edited" },
      ],
    });
    expect(outcome).toEqual({ ok: true, newHeadSha: "commit-sha" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST", "POST", "POST", "PATCH"]);
  });

  test("a file deleted at the head also fails as a conflict", async () => {
    const { fetch } = makeFetch(async (req) => {
      if (req.url.includes("/contents/a.md?ref=h0")) return jsonResponse({ sha: "blob-old" });
      if (req.url.includes("/contents/a.md?ref=h1"))
        return jsonResponse({ message: "Not Found" }, 404);
      throw new Error(`unexpected call: ${req.url}`);
    });
    const transport = createGitHubTransport({ token: "t", fetch }, PR);
    const outcome = await transport.commit({
      kind: "commit",
      baseSha: "h1",
      headRef: "topic",
      fileEdits: [
        { id: "f1", state: "syncing", path: "a.md", baseSha: "h0", editedSource: "edited" },
      ],
    });
    expect(outcome.ok).toBe(false);
  });
});
