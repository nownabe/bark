# Chrome Web Store listing copy

Ready-to-paste text for the Bark store listing. Keep everything in English.

---

## Product name (≤ 75 chars)

```
Bark — Markdown review for GitHub Pull Requests
```

## Summary / short description (≤ 132 chars)

```
Review Markdown files in GitHub PRs like Google Docs: select any text to comment or suggest, and edit the doc in place.
```

## Category

```
Developer Tools
```

## Language

```
English
```

---

## Detailed description

```
Bark brings a Google Docs-like reviewing experience to Markdown documents in
GitHub Pull Requests. Instead of GitHub's line-based "Files changed" diff, Bark
renders the changed .md files in full and lets you drag-select any text range to
attach a comment or a Suggestion.

WHAT YOU CAN DO
• Read changed Markdown rendered in full — headings, lists, tables, and Mermaid
  diagrams — instead of a raw line diff.
• Select any text range and attach a comment or a GitHub Suggestion right where
  it belongs.
• Resolve and reopen comment and Suggestion threads.
• Draft your review locally and submit it to GitHub in one batch, mirroring
  GitHub's "Start a review → Submit" flow.

HOW IT WORKS
Bark has no backend. You sign in with GitHub's official device flow and pick
which repositories Bark may access. Your draft comments stay in your browser
until you submit them; GitHub remains the single source of truth for everything.

PRIVACY
Bark talks only to github.com and api.github.com. There is no analytics, no
tracking, and no third-party server — the developer receives none of your data.
See the privacy policy for details.

SCOPE
v1 supports github.com (not GitHub Enterprise Server) and asynchronous review
(no real-time collaboration).
```

---

## Privacy tab

### Single purpose (one sentence)

```
Bark renders the changed Markdown files of a GitHub Pull Request and lets you
review them with text-anchored comments and Suggestions.
```

### Permission justifications

Paste one justification per requested permission.

- **storage**

  ```
  Stores the user's GitHub access token and their draft (pending) comments
  locally so a review can be resumed later. Nothing is stored remotely.
  ```

- **scripting**

  ```
  Injects a small "Open in Bark" entry point into GitHub Pull Request pages so
  the user can launch the Bark review view for that PR.
  ```

- **Host permission: `https://github.com/*`**

  ```
  Reads the Pull Request page context and runs GitHub's device-flow auth and
  web endpoints that do not expose CORS headers, which must run from this origin.
  ```

- **Host permission: `https://api.github.com/*`**

  ```
  Calls the GitHub REST/GraphQL API to fetch the PR's changed Markdown files and
  existing comments, and to submit the user's reviews, comments, and Suggestions.
  ```

- **Remote code**: Bark does **not** use remote code. All scripts are bundled in
  the package; no remote fonts or remotely hosted code are loaded.

### Data usage disclosures (be accurate)

In the "Data collected" form, disclose what Bark transmits off the device. Bark
sends data only to GitHub on the user's behalf — never to the developer.

- **Authentication information** — used for app functionality (the GitHub token
  is sent to GitHub's API to act on the user's behalf). Stored locally.
- **Website content / user-generated content** — the comments and Suggestions
  the user writes are sent to GitHub when they submit a review.

Then certify the three required statements (all true for Bark):

- I do not sell or transfer user data to third parties (outside approved uses).
- I do not use or transfer user data for purposes unrelated to the single purpose.
- I do not use or transfer user data to determine creditworthiness / for lending.

### Privacy policy URL

```
https://nownabe.github.io/bark/privacy/
```

---

## Graphic assets

- **Store icon**: 128×128 PNG — already in repo at `public/icon/128.png`.
- **Screenshots**: 1–5 required. Each 1280×800 or 640×400 PNG/JPEG. Capture the
  Bark review view on a real PR:
  1. Rendered Markdown with a selection bubble / comment composer open.
  2. A Suggestion diff in a thread.
  3. The submit-review flow (pending comments → submit).
- **Small promo tile** (optional): 440×280 PNG.
