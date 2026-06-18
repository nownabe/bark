import { afterEach, describe, expect, mock, test } from "bun:test";
import { validatePat, PatError } from "../lib/pat";

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
    json: async () => body,
  } as unknown as Response;
}

describe("validatePat", () => {
  test("normalizes a 200 into PatIdentity", async () => {
    stubFetch(() => jsonResponse(200, { login: "octocat", avatar_url: "https://x/a.png" }));
    expect(await validatePat("ghp_token")).toEqual({
      login: "octocat",
      avatarUrl: "https://x/a.png",
    });
  });

  test("sends the token as a bearer header", async () => {
    let seen: RequestInit | undefined;
    stubFetch((_url, init) => {
      seen = init;
      return jsonResponse(200, { login: "octocat", avatar_url: "https://x/a.png" });
    });
    await validatePat("  ghp_token  ");
    const headers = seen!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghp_token");
  });

  test("401 throws PatError invalid", async () => {
    stubFetch(() => jsonResponse(401, {}));
    const err = await validatePat("bad").catch((e) => e);
    expect(err).toBeInstanceOf(PatError);
    expect(err.kind).toBe("invalid");
  });

  test("403 throws PatError forbidden", async () => {
    stubFetch(() => jsonResponse(403, {}));
    const err = await validatePat("scoped-wrong").catch((e) => e);
    expect(err.kind).toBe("forbidden");
  });

  test("a thrown fetch maps to PatError network", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const err = await validatePat("ghp_token").catch((e) => e);
    expect(err.kind).toBe("network");
  });

  test("empty/whitespace input is rejected without calling fetch", async () => {
    let called = 0;
    stubFetch(() => {
      called++;
      return jsonResponse(200, {});
    });
    const err = await validatePat("   ").catch((e) => e);
    expect(err.kind).toBe("invalid");
    expect(called).toBe(0);
  });
});
