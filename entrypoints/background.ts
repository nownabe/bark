// Background service worker — Design Doc §6.
// Opens the review SPA page on request from the content script. Future
// responsibilities may include auth/API/storage routing.
interface OpenMessage {
  type: 'bark/open';
  ref: { owner: string; repo: string; pr: string };
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as { type?: string } | null;
    switch (msg?.type) {
      case 'bark/open': {
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
