// Fine-grained PAT validation — the page-side alternative to the device flow.
//
// Unlike github.com's /login/* device endpoints (no CORS headers, so they run
// in the background worker), api.github.com sends CORS headers, so we validate
// a pasted token here in the page with a direct GET /user. The token is fed to
// GitHubClient unchanged once validated; persistence stays in storage.ts.

export interface PatIdentity {
  login: string;
  avatarUrl: string;
}

export type PatErrorKind = "invalid" | "forbidden" | "network";

export class PatError extends Error {
  constructor(
    readonly kind: PatErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PatError";
  }
}

const USER_URL = "https://api.github.com/user";

/** Verify a fine-grained PAT by calling GET /user; resolve to the identity. */
export async function validatePat(token: string): Promise<PatIdentity> {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new PatError("invalid", "Token is invalid or expired.");
  }

  let res: Response;
  try {
    res = await fetch(USER_URL, {
      headers: {
        Authorization: `Bearer ${trimmed}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    throw new PatError("network", "Couldn't reach GitHub. Check your connection and try again.");
  }

  if (res.status === 401) {
    throw new PatError("invalid", "Token is invalid or expired.");
  }
  if (res.status === 403) {
    throw new PatError(
      "forbidden",
      "Token lacks the required access. Check its Contents and Pull requests permissions.",
    );
  }
  if (!res.ok) {
    throw new PatError("network", "GitHub returned an unexpected error. Please try again.");
  }

  const body = (await res.json()) as { login?: string; avatar_url?: string };
  return { login: body.login ?? "", avatarUrl: body.avatar_url ?? "" };
}
