import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  avatarUrl,
  buildBlobPermalink,
  buildSuggestionBlock,
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
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = mock(impl) as unknown as typeof fetch;
}
function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

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
  const ref = { owner: "o", repo: "r", number: 1 };
  test("multi-line range", () => {
    expect(buildBlobPermalink(ref, "a/b.md", "sha", 3, 5)).toBe(
      "https://github.com/o/r/blob/sha/a/b.md#L3-L5",
    );
  });
  test("single line", () => {
    expect(buildBlobPermalink(ref, "a/b.md", "sha", 3, 3)).toBe(
      "https://github.com/o/r/blob/sha/a/b.md#L3",
    );
  });
});

describe("buildSuggestionBlock", () => {
  test("wraps replacement in a suggestion fence", () => {
    expect(buildSuggestionBlock("const x = 2;")).toBe("```suggestion\nconst x = 2;\n```");
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
