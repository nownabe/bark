import { describe, expect, test } from "bun:test";
import type { PrRef } from "../../lib/pr/github-transport";
import { listReviewThreads } from "../../lib/pr/review-threads";

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

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function variablesOf(req: CallRecord): Record<string, unknown> {
  return (JSON.parse(req.body ?? "{}") as { variables: Record<string, unknown> }).variables;
}

function threadsPage(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
) {
  return jsonResponse({
    data: {
      repository: {
        pullRequest: { reviewThreads: { nodes, pageInfo } },
      },
    },
  });
}

function threadNode(id: string, isResolved: boolean, comments: unknown[]) {
  return {
    id,
    isResolved,
    comments: {
      nodes: comments,
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

describe("review-threads — outer reviewThreads pagination", () => {
  test("follows pageInfo.endCursor until hasNextPage is false", async () => {
    const { fetch, calls } = makeFetch(async (req) => {
      const vars = variablesOf(req);
      if (vars.cursor === null || vars.cursor === undefined) {
        return threadsPage([threadNode("PRT_1", true, [])], {
          hasNextPage: true,
          endCursor: "CUR1",
        });
      }
      if (vars.cursor === "CUR1") {
        return threadsPage([threadNode("PRT_2", false, [])], {
          hasNextPage: false,
          endCursor: null,
        });
      }
      throw new Error(`unexpected cursor: ${String(vars.cursor)}`);
    });
    const out = await listReviewThreads({ token: "t", fetch }, PR);
    expect(out.map((t) => `${t.id}:${t.isResolved}`)).toEqual(["PRT_1:true", "PRT_2:false"]);
    expect(calls).toHaveLength(2);
    expect(variablesOf(calls[1]!)).toMatchObject({ cursor: "CUR1" });
  });

  test("tolerates a response without pageInfo (treated as single page)", async () => {
    const { fetch, calls } = makeFetch(async () =>
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "PRT_1",
                    isResolved: false,
                    comments: { nodes: [{ databaseId: 1, body: "b" }] },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const out = await listReviewThreads({ token: "t", fetch }, PR);
    expect(out).toHaveLength(1);
    expect(out[0]?.comments).toEqual([{ databaseId: 1, body: "b" }]);
    expect(calls).toHaveLength(1);
  });
});

describe("review-threads — nested comments pagination", () => {
  test("fetches remaining comment pages for a thread whose comments overflow", async () => {
    const { fetch, calls } = makeFetch(async (req) => {
      const vars = variablesOf(req);
      if (vars.threadId === undefined) {
        return threadsPage(
          [
            {
              id: "PRT_BIG",
              isResolved: true,
              comments: {
                nodes: [{ databaseId: 1, body: "first" }],
                pageInfo: { hasNextPage: true, endCursor: "CC1" },
              },
            },
          ],
          { hasNextPage: false, endCursor: null },
        );
      }
      if (vars.threadId === "PRT_BIG" && vars.cursor === "CC1") {
        return jsonResponse({
          data: {
            node: {
              comments: {
                nodes: [{ databaseId: 2, body: "second" }],
                pageInfo: { hasNextPage: true, endCursor: "CC2" },
              },
            },
          },
        });
      }
      if (vars.threadId === "PRT_BIG" && vars.cursor === "CC2") {
        return jsonResponse({
          data: {
            node: {
              comments: {
                nodes: [{ databaseId: 3, body: "third" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      throw new Error(`unexpected variables: ${JSON.stringify(vars)}`);
    });
    const out = await listReviewThreads({ token: "t", fetch }, PR);
    expect(out).toHaveLength(1);
    expect(out[0]?.comments.map((c) => c.body)).toEqual(["first", "second", "third"]);
    expect(calls).toHaveLength(3);
  });
});
