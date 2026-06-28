// Per-test GitHub API mock. Installs a `page.route()` handler that
// intercepts every `https://api.github.com/**` request and resolves it
// from the caller-supplied scenario. Unhandled paths return 404 by
// default so the test fails loudly on unmocked traffic.
import type { Page, Route } from "@playwright/test";

export type RouteHandler = (route: Route) => Promise<void> | void;

export type GitHubScenario = {
  /** Map of `${method} ${pathRegex}` → handler. Regex is matched against
   *  the URL pathname (search-query unaware). */
  routes?: Array<{ method: string; path: RegExp; handler: RouteHandler }>;
  /** Default for unmatched calls. `404` (default) makes drift loud;
   *  `passthrough` lets the real network through (do not use in CI). */
  unmatched?: "404" | "passthrough";
};

export async function mockGitHub(page: Page, scenario: GitHubScenario): Promise<void> {
  await page.route(/^https:\/\/api\.github\.com\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    for (const r of scenario.routes ?? []) {
      if (req.method() === r.method && r.path.test(url.pathname)) {
        return r.handler(route);
      }
    }
    if (scenario.unmatched === "passthrough") return route.continue();
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ unmocked: { method: req.method(), url: req.url() } }),
    });
  });
}

/** Convenience: a JSON-body handler. */
export function json(status: number, body: unknown): RouteHandler {
  return (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
}
