import { defineConfig } from "wxt";

// WXT config — see https://wxt.dev/api/config.html
// Manifest maps to Design Doc §10 (Manifest V3 / permissions).
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
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
    // §10: content script injection + storage. API calls run in the browser.
    permissions: ["storage", "scripting"],
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
