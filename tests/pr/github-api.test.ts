import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearEtagCache,
  ghGraphQL,
  ghPaginate,
  GitHubApiError,
  ghRequest,
} from "../../lib/pr/github-api";

// Backoff sleeper stubbed to a no-op so retry tests don't wait on real timers.
const noDelay = () => Promise.resolve();

beforeEach(() => {
  clearEtagCache();
});

type CallRecord = {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
};

function makeFetch(
  responses: Array<Partial<Response> | ((req: CallRecord) => Partial<Response>)>,
): { fetch: typeof fetch; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  let i = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    const record = { url, method, body: init?.body as string | undefined, headers };
    calls.push(record);
    const r = responses[i++];
    const resolved = typeof r === "function" ? r(record) : r;
    return resolved as Response;
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

describe("github-api — ghRequest", () => {
  test("sends a GET with auth headers and parses JSON", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ foo: 1 })]);
    const out = await ghRequest<{ foo: number }>(
      { token: "t", fetch },
      "GET",
      "/repos/x/y/pulls/1",
    );
    expect(out).toEqual({ foo: 1 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("https://api.github.com/repos/x/y/pulls/1");
    expect(calls[0]?.headers.Authorization).toBe("Bearer t");
  });

  test("includes JSON body and content-type when a body is provided", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ id: 7 })]);
    await ghRequest({ token: "t", fetch }, "POST", "/p", { x: 1 });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.body).toBe('{"x":1}');
  });

  test("throws GitHubApiError on non-2xx", async () => {
    const resp = {
      ok: false,
      status: 422,
      text: async () => "unprocessable",
    } as unknown as Response;
    const { fetch } = makeFetch([resp]);
    let caught: unknown;
    try {
      await ghRequest({ token: "t", fetch }, "POST", "/p", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GitHubApiError);
    expect((caught as GitHubApiError).status).toBe(422);
    expect((caught as GitHubApiError).detail).toBe("unprocessable");
  });

  test("204 No Content returns undefined", async () => {
    const resp = {
      ok: true,
      status: 204,
      headers: new Headers(),
    } as unknown as Response;
    const { fetch } = makeFetch([resp]);
    const out = await ghRequest({ token: "t", fetch }, "DELETE", "/p");
    expect(out).toBeUndefined();
  });
});

describe("github-api — ghGraphQL", () => {
  test("POSTs query/variables and returns data", async () => {
    const { fetch, calls } = makeFetch([jsonResponse({ data: { v: 1 } })]);
    const out = await ghGraphQL<{ v: number }>({ token: "t", fetch }, "query { v }", { a: 1 });
    expect(out).toEqual({ v: 1 });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.github.com/graphql");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      query: "query { v }",
      variables: { a: 1 },
    });
  });

  test("throws when GraphQL response has errors", async () => {
    const { fetch } = makeFetch([jsonResponse({ errors: [{ message: "bad" }] })]);
    let caught: unknown;
    try {
      await ghGraphQL({ token: "t", fetch }, "query {}", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GitHubApiError);
  });
});

describe("github-api — ghPaginate", () => {
  test("returns a single page when no Link header is present", async () => {
    const { fetch } = makeFetch([jsonResponse([{ id: 1 }, { id: 2 }])]);
    const out = await ghPaginate<{ id: number }>({ token: "t", fetch }, "/x");
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("follows the rel=next link to the end", async () => {
    const { fetch } = makeFetch([
      jsonResponse([{ id: 1 }], 200, {
        Link: '<https://api.github.com/x?page=2>; rel="next"',
      }),
      jsonResponse([{ id: 2 }], 200, {
        Link: '<https://api.github.com/x?page=3>; rel="next"',
      }),
      jsonResponse([{ id: 3 }]),
    ]);
    const out = await ghPaginate<{ id: number }>({ token: "t", fetch }, "/x");
    expect(out).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });
});

// ---- ETag conditional requests (issue #9a) -----------------------------

/** A 304 Not Modified response — no JSON body is read on this path. */
function notModified(headers: Record<string, string> = {}) {
  return {
    ok: false,
    status: 304,
    headers: new Headers(headers),
    json: async () => {
      throw new Error("304 has no body");
    },
    text: async () => "",
  } as unknown as Response;
}

describe("github-api — ETag caching", () => {
  test("caches on 200 with ETag, then sends If-None-Match and replays body on 304", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ v: 1 }, 200, { ETag: 'W/"abc"' }),
      notModified(),
    ]);
    const client = { token: "t", fetch };
    const first = await ghRequest<{ v: number }>(client, "GET", "/repos/x/y/pulls/1");
    expect(first).toEqual({ v: 1 });
    // First call must NOT carry a conditional header (nothing cached yet).
    expect(calls[0]?.headers["If-None-Match"]).toBeUndefined();

    const second = await ghRequest<{ v: number }>(client, "GET", "/repos/x/y/pulls/1");
    // 304 -> the cached body is returned without re-parsing JSON.
    expect(second).toEqual({ v: 1 });
    expect(calls[1]?.headers["If-None-Match"]).toBe('W/"abc"');
  });

  test("a fresh 200 (ETag miss) updates the cache with the new body/etag", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ v: 1 }, 200, { ETag: '"one"' }),
      jsonResponse({ v: 2 }, 200, { ETag: '"two"' }),
      notModified(),
    ]);
    const client = { token: "t", fetch };
    await ghRequest(client, "GET", "/e");
    const second = await ghRequest<{ v: number }>(client, "GET", "/e");
    expect(second).toEqual({ v: 2 }); // server returned a new body, not 304
    expect(calls[1]?.headers["If-None-Match"]).toBe('"one"');

    const third = await ghRequest<{ v: number }>(client, "GET", "/e");
    expect(third).toEqual({ v: 2 }); // 304 replays the *updated* cache
    expect(calls[2]?.headers["If-None-Match"]).toBe('"two"');
  });

  test("does not cache or send conditional headers for non-GET requests", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse({ id: 1 }, 201, { ETag: '"x"' }),
      jsonResponse({ id: 2 }, 201, { ETag: '"y"' }),
    ]);
    const client = { token: "t", fetch };
    await ghRequest(client, "POST", "/p", { a: 1 });
    await ghRequest(client, "POST", "/p", { a: 1 });
    expect(calls[1]?.headers["If-None-Match"]).toBeUndefined();
  });

  test("ghPaginate replays a page body on 304", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse([{ id: 1 }], 200, { ETag: '"p1"' }),
      notModified(),
    ]);
    const client = { token: "t", fetch };
    const first = await ghPaginate<{ id: number }>(client, "/x");
    expect(first).toEqual([{ id: 1 }]);
    const second = await ghPaginate<{ id: number }>(client, "/x");
    expect(second).toEqual([{ id: 1 }]);
    expect(calls[1]?.headers["If-None-Match"]).toBe('"p1"');
  });
});

// ---- Retry with backoff (issue #9b) ------------------------------------

function fiveHundred() {
  return {
    ok: false,
    status: 503,
    headers: new Headers(),
    text: async () => "unavailable",
  } as unknown as Response;
}

describe("github-api — retry with backoff", () => {
  test("retries a 5xx GET and succeeds", async () => {
    const { fetch, calls } = makeFetch([fiveHundred(), jsonResponse({ ok: true })]);
    const out = await ghRequest<{ ok: boolean }>(
      { token: "t", fetch, delay: noDelay },
      "GET",
      "/x",
    );
    expect(out).toEqual({ ok: true });
    expect(calls.length).toBe(2);
  });

  test("retries a network error (fetch rejection) on GET and succeeds", async () => {
    let i = 0;
    const flakyFetch = (async () => {
      i++;
      if (i === 1) throw new TypeError("network down");
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const out = await ghRequest<{ ok: boolean }>(
      { token: "t", fetch: flakyFetch, delay: noDelay },
      "GET",
      "/x",
    );
    expect(out).toEqual({ ok: true });
    expect(i).toBe(2);
  });

  test("does NOT retry a mutation (POST) on 5xx", async () => {
    const { fetch, calls } = makeFetch([fiveHundred(), jsonResponse({ ok: true })]);
    let caught: unknown;
    try {
      await ghRequest({ token: "t", fetch, delay: noDelay }, "POST", "/p", { a: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GitHubApiError);
    expect((caught as GitHubApiError).status).toBe(503);
    expect(calls.length).toBe(1); // ran exactly once
  });

  test("surfaces the error after retries are exhausted", async () => {
    const { fetch, calls } = makeFetch([fiveHundred(), fiveHundred(), fiveHundred()]);
    let caught: unknown;
    try {
      await ghRequest({ token: "t", fetch, delay: noDelay }, "GET", "/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GitHubApiError);
    expect((caught as GitHubApiError).status).toBe(503);
    expect(calls.length).toBe(3); // initial + 2 retries
  });

  test("does NOT retry a non-transient 4xx GET", async () => {
    const notFound = {
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => "nope",
    } as unknown as Response;
    const { fetch, calls } = makeFetch([notFound, jsonResponse({ ok: true })]);
    let caught: unknown;
    try {
      await ghRequest({ token: "t", fetch, delay: noDelay }, "GET", "/x");
    } catch (e) {
      caught = e;
    }
    expect((caught as GitHubApiError).status).toBe(404);
    expect(calls.length).toBe(1);
  });
});
