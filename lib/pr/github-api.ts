// Low-level GitHub REST + GraphQL client. Provides token-authenticated
// `ghRequest`, `ghGraphQL`, and `ghPaginate` (Link-header following).
// The Transport (github-transport.ts) and Fetcher build on these.
//
// The `fetch` implementation is injectable on the client object so tests
// can substitute a stub without needing a real network or a global mock.
//
// Hardening (issue #9):
//   - GET requests send `If-None-Match` from an in-memory ETag cache and,
//     on a 304, return the cached body. A 304 does NOT count against the
//     REST rate limit, so this is pure quota savings across a page/service-
//     worker lifetime. The cache is a module-level Map (no persistence
//     needed — MV3 service worker / review-page lifetime is fine).
//   - Idempotent reads (GET, and GET-only pagination) retry transient
//     failures (network rejection, 5xx) with a small bounded exponential
//     backoff. Mutations (POST/PUT/PATCH/DELETE) are NEVER retried — a
//     repeated commit/comment would duplicate side effects. GraphQL is not
//     retried either: `ghGraphQL` cannot tell a query from a mutation.

const DEFAULT_BASE = "https://api.github.com";
const DEFAULT_GQL = "https://api.github.com/graphql";

export type GitHubClient = {
  token: string;
  baseUrl?: string;
  graphqlUrl?: string;
  fetch?: typeof fetch;
  /** Injectable backoff sleeper (tests pass a no-op to avoid real timers). */
  delay?: (ms: number) => Promise<void>;
};

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`GitHub API ${status}: ${detail}`);
    this.name = "GitHubApiError";
  }
}

// ---- ETag cache --------------------------------------------------------

/** url -> { etag, body, next }. GET-only; a 304 replays `body` for free (no
 *  rate-limit cost). Module-level: shared across all clients for the
 *  page / service-worker lifetime; there is no persistence by design.
 *
 *  `next` is the paginated rel=next link; a 304 is not required to repeat the
 *  `Link` header, so the cached value is what keeps the page walk going.
 *  It is absent for entries written by non-paginated GETs. */
const etagCache = new Map<string, { etag: string; body: unknown; next?: string | null }>();

/** Test seam: drop cached ETags so cases don't leak into one another. */
export function clearEtagCache(): void {
  etagCache.clear();
}

// ---- Retry with backoff ------------------------------------------------

const BACKOFF_MS = [300, 900];

const defaultDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True when the failure is worth retrying an idempotent read: a network
 *  rejection (no `status`) or a 5xx response. */
function isTransient(err: unknown): boolean {
  if (err instanceof GitHubApiError) return err.status >= 500 && err.status < 600;
  return true; // fetch rejection (network / DNS / TLS)
}

/** Run an idempotent operation, retrying transient failures with a small
 *  bounded exponential backoff. Non-transient errors surface immediately. */
async function withRetry<T>(client: GitHubClient, op: () => Promise<T>): Promise<T> {
  const sleep = client.delay ?? defaultDelay;
  for (const backoff of BACKOFF_MS) {
    try {
      return await op();
    } catch (err) {
      if (!isTransient(err)) throw err;
      await sleep(backoff);
    }
  }
  return op();
}

// ---- Requests ----------------------------------------------------------

export async function ghRequest<T>(
  client: GitHubClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = (client.baseUrl ?? DEFAULT_BASE) + path;
  const isGet = method.toUpperCase() === "GET";
  const send = () => sendRequest<T>(client, method, url, isGet, body);
  // Only idempotent GETs retry; mutations run exactly once.
  return isGet ? withRetry(client, send) : send();
}

async function sendRequest<T>(
  client: GitHubClient,
  method: string,
  url: string,
  isGet: boolean,
  body: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${client.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const cached = isGet ? etagCache.get(url) : undefined;
  if (cached) headers["If-None-Match"] = cached.etag;
  let bodyInit: BodyInit | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyInit = JSON.stringify(body);
  }
  const f = client.fetch ?? fetch;
  const resp = await f(url, { method, headers, body: bodyInit });
  // 304 Not Modified: the cached body is still current (and this response
  // did not cost a rate-limit unit). Replay it.
  if (isGet && resp.status === 304 && cached) return cached.body as T;
  if (!resp.ok) {
    throw new GitHubApiError(resp.status, await safeText(resp));
  }
  if (resp.status === 204) return undefined as T;
  const parsed = (await resp.json()) as T;
  if (isGet) {
    const etag = resp.headers.get("ETag");
    if (etag) etagCache.set(url, { etag, body: parsed });
  }
  return parsed;
}

export async function ghGraphQL<T>(
  client: GitHubClient,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const url = client.graphqlUrl ?? DEFAULT_GQL;
  const f = client.fetch ?? fetch;
  const resp = await f(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${client.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    throw new GitHubApiError(resp.status, await safeText(resp));
  }
  const json = (await resp.json()) as { data?: T; errors?: unknown[] };
  if (json.errors && json.errors.length > 0) {
    throw new GitHubApiError(0, JSON.stringify(json.errors));
  }
  if (json.data === undefined) {
    throw new GitHubApiError(0, "GraphQL response had no data");
  }
  return json.data;
}

export async function ghPaginate<T>(client: GitHubClient, path: string): Promise<T[]> {
  const items: T[] = [];
  let nextPath: string | null = path;
  const base = client.baseUrl ?? DEFAULT_BASE;
  while (nextPath !== null) {
    const url: string = nextPath.startsWith("http") ? nextPath : base + nextPath;
    // Each page is an idempotent GET: retry transient failures per page.
    const page: { items: T[]; next: string | null } = await withRetry(client, () =>
      fetchPage<T>(client, url),
    );
    items.push(...page.items);
    nextPath = page.next;
  }
  return items;
}

async function fetchPage<T>(
  client: GitHubClient,
  url: string,
): Promise<{ items: T[]; next: string | null }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${client.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const cached = etagCache.get(url);
  if (cached) headers["If-None-Match"] = cached.etag;
  const f = client.fetch ?? fetch;
  const resp = await f(url, { headers });
  if (resp.status === 304 && cached) {
    return {
      items: cached.body as T[],
      next: cached.next ?? parseNextLink(resp.headers.get("Link")),
    };
  }
  if (!resp.ok) {
    throw new GitHubApiError(resp.status, await safeText(resp));
  }
  const items = (await resp.json()) as T[];
  const next = parseNextLink(resp.headers.get("Link"));
  const etag = resp.headers.get("ETag");
  if (etag) etagCache.set(url, { etag, body: items, next });
  return { items, next };
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  return match?.[1] ?? null;
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
