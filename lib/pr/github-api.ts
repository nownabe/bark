// Low-level GitHub REST + GraphQL client. Provides token-authenticated
// `ghRequest`, `ghGraphQL`, and `ghPaginate` (Link-header following).
// The Transport (github-transport.ts) and Fetcher build on these.
//
// The `fetch` implementation is injectable on the client object so tests
// can substitute a stub without needing a real network or a global mock.

const DEFAULT_BASE = "https://api.github.com";
const DEFAULT_GQL = "https://api.github.com/graphql";

export type GitHubClient = {
  token: string;
  baseUrl?: string;
  graphqlUrl?: string;
  fetch?: typeof fetch;
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

export async function ghRequest<T>(
  client: GitHubClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = (client.baseUrl ?? DEFAULT_BASE) + path;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${client.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  let bodyInit: BodyInit | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyInit = JSON.stringify(body);
  }
  const f = client.fetch ?? fetch;
  const resp = await f(url, { method, headers, body: bodyInit });
  if (!resp.ok) {
    throw new GitHubApiError(resp.status, await safeText(resp));
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
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
  const f = client.fetch ?? fetch;
  while (nextPath !== null) {
    const url = nextPath.startsWith("http") ? nextPath : base + nextPath;
    const resp = await f(url, {
      headers: {
        Authorization: `Bearer ${client.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!resp.ok) {
      throw new GitHubApiError(resp.status, await safeText(resp));
    }
    const page = (await resp.json()) as T[];
    items.push(...page);
    nextPath = parseNextLink(resp.headers.get("Link"));
  }
  return items;
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
