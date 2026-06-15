// Content script — injects the "Open in Bark" entry point on PR pages.
// Design Doc §6 (Content Script). It only injects the button; the review
// experience (rendering, anchoring) lives in the SPA page.
export default defineContentScript({
  matches: ['https://github.com/*/pull/*'],
  main() {
    injectEntryButton();
    // GitHub navigates via Turbo (SPA-like); re-inject after client-side nav.
    // TODO(next slice): use a more robust nav observer / MutationObserver.
    document.addEventListener('turbo:load', injectEntryButton);
  },
});

function parsePr(): { owner: string; repo: string; pr: string } | null {
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], pr: m[3] };
}

function injectEntryButton() {
  const ref = parsePr();
  if (!ref) return;
  if (document.getElementById('bark-entry')) return;

  const btn = document.createElement('button');
  btn.id = 'bark-entry';
  btn.type = 'button';
  btn.textContent = 'Open in Bark';
  Object.assign(btn.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '9999',
    padding: '8px 14px',
    background: '#1f883d',
    color: '#fff',
    border: '0',
    borderRadius: '6px',
    fontSize: '13px',
    fontWeight: '600',
    cursor: 'pointer',
    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
  } satisfies Partial<CSSStyleDeclaration>);

  btn.addEventListener('click', () => {
    // Ask the background worker to open the page via chrome.tabs.create;
    // window.open(chrome-extension://...) from a content script is blocked
    // with ERR_BLOCKED_BY_CLIENT.
    void browser.runtime.sendMessage({ type: 'bark/open', ref });
  });

  document.body.appendChild(btn);
}
