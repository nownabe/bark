// Background service worker — Design Doc §6.
// Responsibilities (later slices): Auth (token mgmt), GitHub API client
// (fetch / retry / ETag cache), local store I/O (chrome.storage / IndexedDB).
// Scaffold: only a message-router skeleton so the SPA <-> worker channel exists.
export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown) => {
    const type = (message as { type?: string } | null)?.type;
    switch (type) {
      // TODO(next slice): 'auth/*', 'github/*', 'storage/*' handlers.
      default:
        return undefined; // not handled
    }
  });
});
