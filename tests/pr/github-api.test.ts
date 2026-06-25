import { describe, expect, test } from "bun:test";
import { ghGraphQL, ghPaginate, GitHubApiError, ghRequest } from "../../lib/pr/github-api";

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
