// Content script — injects the "Open in DocReview" entry point on PR pages.
// Design Doc §6 (Content Script). Scaffold: only injects the button; the review
// experience (rendering, anchoring) lives in the SPA page and is built later.
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
  if (document.getElementById('docreview-entry')) return;

  const btn = document.createElement('button');
  btn.id = 'docreview-entry';
  btn.type = 'button';
  btn.textContent = 'Open in DocReview';
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
    const params = new URLSearchParams(ref);
    const url = `${browser.runtime.getURL('/review.html')}?${params.toString()}`;
    window.open(url, '_blank');
  });

  document.body.appendChild(btn);
}
