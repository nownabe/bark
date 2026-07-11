// Content script — injects the "Open in Bark" entry point on PR pages.
// Runs on all github.com pages so Turbo navigation onto a PR still injects.
// Design Doc §6 (Content Script). It only injects the button; the review
// experience (rendering, anchoring) lives in the SPA page.
export default defineContentScript({
  // Match every github.com page, not just /pull/: GitHub navigates via Turbo
  // (same-document pushState), so a /pull/-only match never injects when the
  // user reaches a PR from the pulls list or repo home (#189). syncEntryButton
  // keeps the injection itself PR-page-only.
  matches: ["https://github.com/*"],
  main() {
    syncEntryButton();
    // Re-sync after each Turbo client-side navigation.
    // TODO(next slice): use a more robust nav observer / MutationObserver.
    document.addEventListener("turbo:load", syncEntryButton);
  },
});

function parsePr(): { owner: string; repo: string; pr: string } | null {
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], pr: m[3] };
}

function syncEntryButton() {
  const ref = parsePr();
  const existing = document.getElementById("bark-entry");
  if (!ref) {
    // Turbo usually swaps <body> (dropping the button), but remove explicitly
    // so a nav that keeps the body can't leave the button on a non-PR page.
    existing?.remove();
    return;
  }
  if (existing) return;

  // The icon IS the button: a round, transparent floating action button that
  // shows the Bark mascot. The label lives in the tooltip/aria-label so the
  // green checkmark mascot can stand on its own without a boxy text chrome.
  const btn = document.createElement("button");
  btn.id = "bark-entry";
  btn.type = "button";
  btn.title = "Open in Bark";
  btn.setAttribute("aria-label", "Open in Bark");
  Object.assign(btn.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: "9999",
    width: "56px",
    height: "56px",
    padding: "6px",
    background: "#fff",
    border: "1px solid rgba(27,31,36,0.15)",
    borderRadius: "50%",
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
    transition: "transform 0.12s ease, box-shadow 0.12s ease",
  } satisfies Partial<CSSStyleDeclaration>);

  const icon = document.createElement("img");
  icon.src = browser.runtime.getURL("/icon/128.png");
  icon.alt = "";
  Object.assign(icon.style, {
    width: "100%",
    height: "100%",
    display: "block",
    objectFit: "contain",
  } satisfies Partial<CSSStyleDeclaration>);
  btn.appendChild(icon);

  btn.addEventListener("mouseenter", () => {
    btn.style.transform = "scale(1.08)";
    btn.style.boxShadow = "0 4px 14px rgba(0,0,0,0.25)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.transform = "scale(1)";
    btn.style.boxShadow = "0 2px 8px rgba(0,0,0,0.18)";
  });

  btn.addEventListener("click", () => {
    // Re-parse at click time: Turbo can navigate to a different PR while the
    // button survives, so a ref captured at injection time can go stale (#87).
    const current = parsePr();
    if (!current) return;
    // Ask the background worker to open the page via chrome.tabs.create;
    // window.open(chrome-extension://...) from a content script is blocked
    // with ERR_BLOCKED_BY_CLIENT.
    void browser.runtime.sendMessage({ type: "bark/open", ref: current });
  });

  document.body.appendChild(btn);
}
