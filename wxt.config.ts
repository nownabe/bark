import { defineConfig } from "wxt";

// WXT config — see https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // Expose BARK_-prefixed env vars to the bundle (e.g. BARK_GITHUB_CLIENT_ID).
  // The prefix gate keeps non-prefixed secrets like GH_PAT out of the
  // shipped extension; WXT_/VITE_ stay enabled for WXT's own conventions.
  vite: () => ({ envPrefix: ["WXT_", "VITE_", "BARK_"] }),
  manifest: {
    name: "Bark",
    description: "Google Docs-like Markdown review for GitHub Pull Requests",
    // Generated from assets/icon.png into public/icon/ (see README/PR).
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png",
    },
    // "storage" for the draft layer. The content script is statically
    // declared (defineContentScript matches), so no "scripting" permission is
    // needed — Chrome Web Store rejects it as declared-but-unused.
    permissions: ["storage"],
    host_permissions: ["https://github.com/*", "https://api.github.com/*"],
    // The "Open in Bark" button (content script) renders the icon, so the
    // file must be reachable from the github.com origin.
    web_accessible_resources: [
      {
        resources: ["icon/128.png"],
        matches: ["https://github.com/*"],
      },
    ],
  },
});
