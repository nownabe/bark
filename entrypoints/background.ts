// Background service worker — Design Doc §6.
// Responsibilities (later slices): Auth (token mgmt), GitHub API client
// (fetch / retry / ETag cache), local store I/O (chrome.storage / IndexedDB).
// Scaffold: only a message-router skeleton so the SPA <-> worker channel exists.
interface OpenMessage {
  type: 'docreview/open';
  ref: { owner: string; repo: string; pr: string };
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as { type?: string } | null;
    switch (msg?.type) {
      case 'docreview/open': {
        const { ref } = msg as OpenMessage;
        const params = new URLSearchParams(ref);
        const url = `${browser.runtime.getURL('/review.html')}?${params.toString()}`;
        void browser.tabs.create({ url });
        return undefined;
      }
      // TODO(next slice): 'auth/*', 'github/*', 'storage/*' handlers.
      default:
        return undefined; // not handled
    }
  });
});
