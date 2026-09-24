// Local preview entry: the real review page against a fixture PR, served by
// Vite with HMR. See `bun run preview`.
import { browser } from "./browser-shim";
import { handleGitHubRequest, PREVIEW_REF } from "./fake-github";

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  return url.startsWith("https://api.github.com/")
    ? handleGitHubRequest(url, init)
    : realFetch(input, init);
}) as typeof fetch;

if (!new URLSearchParams(location.search).has("pr")) {
  const { owner, repo, number } = PREVIEW_REF;
  history.replaceState(null, "", `?owner=${owner}&repo=${repo}&pr=${number}`);
}

// Start signed in; the token never leaves the page (fetch is faked above).
await browser.storage.local.set({ github_token: "preview", auth_method: "pat" });

await import("../../entrypoints/review/main");
