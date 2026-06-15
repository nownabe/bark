import { defineConfig } from 'wxt';

// WXT config — see https://wxt.dev/api/config.html
// Manifest maps to Design Doc §10 (Manifest V3 / permissions).
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Bark',
    description: 'Google Docs-like Markdown review for GitHub Pull Requests',
    // §10: content script injection + storage. API calls run in the browser.
    permissions: ['storage', 'scripting'],
    host_permissions: ['https://github.com/*', 'https://api.github.com/*'],
  },
});
