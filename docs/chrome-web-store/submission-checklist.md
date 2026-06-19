# Chrome Web Store submission checklist

Sequenced steps to publish Bark. Items marked **(you)** are manual actions in the
GitHub or Chrome Web Store UI that cannot be automated here.

## 1. Prerequisites

- [ ] **(you)** Chrome Web Store developer account registered ($5 one-time fee).
- [ ] **(you)** Production GitHub App is **public** and has **Device Flow
      enabled** (App settings → "Enable Device Flow"). Note its `client_id`.
- [x] `package.json` version is `0.1.0`.
- [x] Privacy policy written (`PRIVACY.md` + `site/privacy/index.html`).

## 2. Host the privacy policy on GitHub Pages (Actions deploy)

The `site/` directory is published via GitHub Actions
(`.github/workflows/pages.yaml`) — `docs/` is reserved for other use.

- [ ] **(you)** Repo → **Settings → Pages** → "Build and deployment" → Source:
      **GitHub Actions**.
- [ ] **(you)** Trigger a deploy: merge a change under `site/**` to `main`, or run
      the **Deploy Pages** workflow manually (`workflow_dispatch`).
- [ ] Confirm it resolves at **https://nownabe.github.io/bark/privacy/**
      (this exact URL goes in the listing).

## 3. Build the production package

The production build must bake in the **production** GitHub App `client_id`
(`BARK_GITHUB_CLIENT_ID`). The build runs **outside the sandbox** (see AGENTS.md).

```sh
# Use the production client_id, not the dev one.
BARK_GITHUB_CLIENT_ID="<prod client_id>" bun run build
bun run zip
```

- [ ] Verify `.output/chrome-mv3/manifest.json` shows `"version":"0.1.0"`.
- [ ] Verify the built `background.js` contains the **production** client_id
      (not the dev value).
- [ ] Package produced at `.output/bark-0.1.0-chrome.zip`.
- [ ] Sanity-load the unpacked `.output/chrome-mv3/` in Chrome
      (`chrome://extensions` → Load unpacked) and confirm the device-flow sign-in
      works end to end against the production app.

## 4. Prepare graphic assets

- [ ] Store icon 128×128 — `public/icon/128.png` (already present).
- [ ] **(you)** 1–5 screenshots, 1280×800 or 640×400 (see `listing.md` for the
      suggested shots). Capture on a real PR with rendered Markdown + a comment.
- [ ] (optional) 440×280 small promo tile.

## 5. Create the listing (Developer Dashboard)

- [ ] **(you)** New item → upload `bark-0.1.0-chrome.zip`.
- [ ] **(you)** Fill product name, summary, detailed description, category
      (Developer Tools), language — copy from `listing.md`.
- [ ] **(you)** Upload icon + screenshots.
- [ ] **(you)** Privacy tab: single purpose, permission justifications, data
      usage disclosures, and the privacy policy URL — copy from `listing.md`.
- [ ] **(you)** Certify the three data-use statements.

## 6. Visibility & submit

- [ ] **(you)** Choose visibility (Public, or Unlisted for a soft launch).
- [ ] **(you)** Set distribution regions (default: all).
- [ ] **(you)** Submit for review. Initial review for an extension with broad
      host permissions can take from hours to several days.

## 7. After approval

- [ ] **(you)** Tag the release in git (e.g. `v0.1.0`) to match the published
      version.
- [ ] For future updates: bump `package.json` version, rebuild + re-zip, upload a
      new package version (the version number must always increase).

## Notes / watch-outs

- **Broad host permission** (`https://github.com/*`) draws extra review scrutiny.
  The justification in `listing.md` explains why it is needed; keep it accurate.
- The dev-only env var `BARK_DEV_ROLE_SWITCH` must **not** affect the production
  build — confirm it is unset/false when building for the store.
- Bark loads **no remote code or fonts**; keep it that way (CWS policy).
