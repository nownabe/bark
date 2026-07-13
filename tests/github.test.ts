import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  avatarUrl,
  buildBlobPermalink,
  buildSuggestionBlock,
  clearGitHubEtagCache,
  findThreadNodeId,
  GitHubApiError,
  GitHubClient,
  parseNextLink,
  pullStatus,
  type ReviewThreadInfo,
} from "../lib/github";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  clearGitHubEtagCache();
});
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = mock(impl) as unknown as typeof fetch;
}

type Call = { url: string; init?: RequestInit };
function recordFetch(handler: (call: Call) => Response | Promise<Response>): { calls: Call[] } {
  const calls: Call[] = [];
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler({ url, init });
  }) as unknown as typeof fetch;
  return { calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null } as unknown as Headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const gdRef = { owner: "o", repo: "r", number: 1 };

describe("pullStatus", () => {
  test("merged wins over everything", () => {
    expect(pullStatus({ state: "closed", merged: true, draft: true })).toBe("merged");
  });
  test("draft when open and not merged", () => {
    expect(pullStatus({ state: "open", draft: true })).toBe("draft");
  });
  test("open / closed otherwise", () => {
    expect(pullStatus({ state: "open" })).toBe("open");
    expect(pullStatus({ state: "closed" })).toBe("closed");
  });
});

describe("avatarUrl", () => {
  test("builds the github.com avatar URL with a size", () => {
    expect(avatarUrl("nownabe")).toBe("https://github.com/nownabe.png?size=40");
    expect(avatarUrl("octocat", 20)).toBe("https://github.com/octocat.png?size=20");
  });
  test("encodes the login", () => {
    expect(avatarUrl("a b")).toBe("https://github.com/a%20b.png?size=40");
  });
});

describe("parseNextLink", () => {
  test("extracts the rel=next URL", () => {
    const link =
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';
    expect(parseNextLink(link)).toBe("https://api.github.com/x?page=2");
  });

  test("returns null on the last page / empty / null", () => {
    expect(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(parseNextLink("")).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

describe("buildBlobPermalink", () => {
  test("multi-line range", () => {
    expect(buildBlobPermalink(gdRef, "a/b.md", "sha", 3, 5)).toBe(
      "https://github.com/o/r/blob/sha/a/b.md#L3-L5",
    );
  });
  test("single line", () => {
    expect(buildBlobPermalink(gdRef, "a/b.md", "sha", 3, 3)).toBe(
      "https://github.com/o/r/blob/sha/a/b.md#L3",
    );
  });
});

describe("buildSuggestionBlock", () => {
  test("wraps replacement in a suggestion fence", () => {
    expect(buildSuggestionBlock("const x = 2;")).toBe("```suggestion\nconst x = 2;\n```");
  });

  // Regression: a replacement that itself contains a ``` code fence used to be
  // wrapped in a same-length 3-backtick fence, so GitHub's parser closed the
  // outer suggestion block at the inner ``` and truncated the suggestion.
  // CommonMark allows longer fences — pick one longer than any backtick run
  // in the content so the inner fence cannot close the outer one.
  test("uses a longer fence when the replacement contains ```", () => {
    const inner = "before\n```js\nconst x = 1;\n```\nafter";
    expect(buildSuggestionBlock(inner)).toBe("````suggestion\n" + inner + "\n````");
  });

  test("escalates fence length to outrun the longest backtick run in the content", () => {
    const inner = "a ```` four-tick run";
    expect(buildSuggestionBlock(inner)).toBe("`````suggestion\n" + inner + "\n`````");
  });
});

describe("findThreadNodeId", () => {
  const threads: ReviewThreadInfo[] = [
    { id: "PRRT_1", isResolved: false, commentIds: [10, 11] },
    { id: "PRRT_2", isResolved: true, commentIds: [20] },
  ];
  test("returns the node id of the thread containing the comment", () => {
    expect(findThreadNodeId(threads, 11)).toBe("PRRT_1");
    expect(findThreadNodeId(threads, 20)).toBe("PRRT_2");
  });
  test("returns null when no thread contains the comment", () => {
    expect(findThreadNodeId(threads, 99)).toBeNull();
  });
});

describe("getAuthenticatedUser", () => {
  test("calls /user with the bearer token and returns the login", async () => {
    let seenUrl = "";
    let seenAuth = "";
    stubFetch((url, init) => {
      seenUrl = url;
      seenAuth = (init!.headers as Record<string, string>).Authorization;
      return jsonResponse(200, { login: "octocat", id: 1 });
    });
    const user = await new GitHubClient("tok").getAuthenticatedUser();
    expect(user).toEqual({ login: "octocat" });
    expect(seenUrl).toBe("https://api.github.com/user");
    expect(seenAuth).toBe("Bearer tok");
  });

  test("throws GitHubApiError on a non-OK response", async () => {
    stubFetch(() => jsonResponse(401, {}));
    const err = await new GitHubClient("bad").getAuthenticatedUser().catch((e) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
  });
});

describe("GitHubClient.createBlob", () => {
  test("POSTs base64-encoded content to /git/blobs and returns the sha", async () => {
    const { calls } = recordFetch(() => jsonResponse(201, { sha: "blob-sha" }));
    const client = new GitHubClient("tok");
    const sha = await client.createBlob(gdRef, "hello\n");
    expect(sha).toBe("blob-sha");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/git/blobs");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.encoding).toBe("base64");
    expect(body.content).toBe(btoa("hello\n"));
  });

  test("base64-encodes UTF-8 byte-safely", async () => {
    recordFetch(() => jsonResponse(201, { sha: "blob-sha" }));
    const client = new GitHubClient("tok");
    await client.createBlob(gdRef, "日本語");
    // The body should be the base64 of the UTF-8 bytes (e6 97 a5 e6 9c ac e8 aa 9e), not btoa("日本語") which throws on non-Latin1.
    const expected = btoa(String.fromCharCode(...new TextEncoder().encode("日本語")));
    const lastCall = (
      globalThis.fetch as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.at(-1) as [string, RequestInit];
    expect(JSON.parse(lastCall[1].body as string).content).toBe(expected);
  });

  test("non-2xx throws GitHubApiError", async () => {
    recordFetch(() => jsonResponse(422, { message: "bad" }));
    const client = new GitHubClient("tok");
    const err = await client.createBlob(gdRef, "x").catch((e) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.status).toBe(422);
  });
});

describe("GitHubClient.createTree", () => {
  test("POSTs base_tree + tree entries to /git/trees and returns the tree sha", async () => {
    const { calls } = recordFetch(() => jsonResponse(201, { sha: "tree-sha" }));
    const client = new GitHubClient("tok");
    const sha = await client.createTree(gdRef, {
      baseTree: "head-sha",
      entries: [
        { path: "a.md", mode: "100644", type: "blob", sha: "blob-a" },
        { path: "dir/b.md", mode: "100644", type: "blob", sha: "blob-b" },
      ],
    });
    expect(sha).toBe("tree-sha");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/git/trees");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.base_tree).toBe("head-sha");
    expect(body.tree).toEqual([
      { path: "a.md", mode: "100644", type: "blob", sha: "blob-a" },
      { path: "dir/b.md", mode: "100644", type: "blob", sha: "blob-b" },
    ]);
  });
});

describe("GitHubClient.createCommit", () => {
  test("POSTs message/tree/parents to /git/commits and returns the commit sha", async () => {
    const { calls } = recordFetch(() => jsonResponse(201, { sha: "commit-sha" }));
    const client = new GitHubClient("tok");
    const sha = await client.createCommit(gdRef, {
      message: "docs: update via Bark",
      tree: "tree-sha",
      parents: ["head-sha"],
    });
    expect(sha).toBe("commit-sha");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/git/commits");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({
      message: "docs: update via Bark",
      tree: "tree-sha",
      parents: ["head-sha"],
    });
  });
});

describe("GitHubClient.updateRef", () => {
  test("PATCHes /git/refs/heads/{branch} with force=false", async () => {
    const { calls } = recordFetch(() => jsonResponse(200, { ref: "refs/heads/main" }));
    const client = new GitHubClient("tok");
    await client.updateRef(gdRef, "main", "commit-sha");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/git/refs/heads/main");
    expect(calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ sha: "commit-sha", force: false });
  });

  test("URL-encodes each segment of slash-containing branch names", async () => {
    const { calls } = recordFetch(() => jsonResponse(200, {}));
    const client = new GitHubClient("tok");
    await client.updateRef(gdRef, "feature/a b", "commit-sha");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/git/refs/heads/feature/a%20b");
  });

  test("422 throws GitHubApiError (non-fast-forward)", async () => {
    recordFetch(() => jsonResponse(422, { message: "Update is not a fast forward" }));
    const client = new GitHubClient("tok");
    const err = await client.updateRef(gdRef, "main", "commit-sha").catch((e) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.status).toBe(422);
  });
});

// ---- GET hardening: ETag caching + retry (issue #9) --------------------

/** A response whose `headers.get(name)` honours the given header map (for
 *  ETag / Link). `text()` returns the JSON string so both `.json()` and
 *  `.text()` consumers work. */
function respWithHeaders(status: number, body: unknown, headers: Record<string, string>): Response {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null } as unknown as Headers,
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

const noDelay = () => Promise.resolve();

describe("GitHubClient — ETag caching", () => {
  test("sends If-None-Match after a 200+ETag and replays the cached body on 304", async () => {
    const responses = [
      respWithHeaders(200, { head: { sha: "s", ref: "r" }, title: "T" }, { ETag: '"v1"' }),
      respWithHeaders(304, "", {}),
    ];
    let i = 0;
    const { calls } = recordFetch(() => responses[i++]);
    const client = new GitHubClient("tok");
    const first = await client.getPull(gdRef);
    expect(first.headSha).toBe("s");
    expect((calls[0].init!.headers as Record<string, string>)["If-None-Match"]).toBeUndefined();

    const second = await client.getPull(gdRef);
    expect(second.headSha).toBe("s"); // replayed from cache
    expect((calls[1].init!.headers as Record<string, string>)["If-None-Match"]).toBe('"v1"');
  });

  test("getAllPages replays a cached page body on 304", async () => {
    const responses = [
      respWithHeaders(200, [{ filename: "a.md", status: "modified" }], { ETag: '"p1"' }),
      respWithHeaders(304, "", {}),
    ];
    let i = 0;
    const { calls } = recordFetch(() => responses[i++]);
    const client = new GitHubClient("tok");
    const first = await client.listMarkdownFiles(gdRef);
    expect(first).toEqual([{ path: "a.md", status: "modified", patch: undefined }]);
    const second = await client.listMarkdownFiles(gdRef);
    expect(second).toEqual([{ path: "a.md", status: "modified", patch: undefined }]);
    expect((calls[1].init!.headers as Record<string, string>)["If-None-Match"]).toBe('"p1"');
  });
});

describe("GitHubClient — GET retry with backoff", () => {
  test("retries a 5xx GET and succeeds", async () => {
    const responses = [
      jsonResponse(503, { message: "unavailable" }),
      respWithHeaders(200, { head: { sha: "s", ref: "r" }, title: "T" }, {}),
    ];
    let i = 0;
    recordFetch(() => responses[i++]);
    const client = new GitHubClient("tok", noDelay);
    const info = await client.getPull(gdRef);
    expect(info.headSha).toBe("s");
    expect(i).toBe(2);
  });

  test("retries a network error (fetch rejection) on GET and succeeds", async () => {
    let i = 0;
    globalThis.fetch = mock(async () => {
      i++;
      if (i === 1) throw new TypeError("network down");
      return respWithHeaders(200, { head: { sha: "s", ref: "r" }, title: "T" }, {});
    }) as unknown as typeof fetch;
    const client = new GitHubClient("tok", noDelay);
    const info = await client.getPull(gdRef);
    expect(info.headSha).toBe("s");
    expect(i).toBe(2);
  });

  test("surfaces the error after retries are exhausted", async () => {
    let i = 0;
    recordFetch(() => {
      i++;
      return jsonResponse(503, { message: "unavailable" });
    });
    const client = new GitHubClient("tok", noDelay);
    const err = await client.getPull(gdRef).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.status).toBe(503);
    expect(i).toBe(3); // initial + 2 retries
  });

  test("does not retry a mutation (post) on 5xx", async () => {
    let i = 0;
    recordFetch(() => {
      i++;
      return jsonResponse(503, { message: "unavailable" });
    });
    const client = new GitHubClient("tok", noDelay);
    const err = await client.createIssueComment(gdRef, "hi").catch((e) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(i).toBe(1); // ran exactly once
  });
});
