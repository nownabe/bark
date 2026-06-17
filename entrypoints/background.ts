// Background service worker — Design Doc §6.
//  - Opens the review SPA page on request from the content script.
//  - Runs the GitHub App device-flow network calls (§7.6 / D10). Those endpoints
//    live on github.com and send no CORS headers, so they must run here, where
//    host_permissions grants the worker a CORS bypass — a page fetch would fail.
import type { TokenMessage } from "../lib/auth";

interface OpenMessage {
  type: "bark/open";
  ref: { owner: string; repo: string; pr: string };
}

// Public, build-time client_id of the GitHub App (not a secret). Set it via
// BARK_GITHUB_CLIENT_ID in .envrc.local (see .envrc.local.example).
const CLIENT_ID = import.meta.env.BARK_GITHUB_CLIENT_ID;
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

async function postForm(url: string, params: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  return res.json();
}

const missingClientId = {
  error: "config_error",
  error_description:
    "BARK_GITHUB_CLIENT_ID is not set. Build the extension with the GitHub App client_id (see .envrc.local.example).",
};

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as { type?: string } | null;
    switch (msg?.type) {
      case "bark/open": {
        const { ref } = msg as OpenMessage;
        const params = new URLSearchParams(ref);
        const url = `${browser.runtime.getURL("/review.html")}?${params.toString()}`;
        void browser.tabs.create({ url });
        return undefined;
      }
      // Device flow (§7.6): returning a Promise sends its resolved value as the
      // response. GitHub's JSON is forwarded verbatim; lib/auth.ts normalizes it.
      case "bark/auth/device-code": {
        if (!CLIENT_ID) return Promise.resolve(missingClientId);
        return postForm(DEVICE_CODE_URL, { client_id: CLIENT_ID });
      }
      case "bark/auth/token": {
        if (!CLIENT_ID) return Promise.resolve(missingClientId);
        const { deviceCode } = msg as TokenMessage;
        return postForm(ACCESS_TOKEN_URL, {
          client_id: CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
      }
      default:
        return undefined; // not handled
    }
  });
});
