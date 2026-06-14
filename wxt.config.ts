import { defineConfig } from 'wxt';

// WXT config — see https://wxt.dev/api/config.html
// Manifest maps to Design Doc §10 (Manifest V3 / 権限).
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'DocReview',
    description: 'Google Docs-like Markdown review for GitHub Pull Requests',
    // §10: content script 注入 + storage。実 API 呼び出しは後続スライス。
    permissions: ['storage', 'scripting'],
    host_permissions: ['https://github.com/*', 'https://api.github.com/*'],
  },
});
