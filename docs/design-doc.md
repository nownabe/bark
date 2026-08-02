# Bark — Design Doc

> Status: living document. Originally drafted 2026-06-06 (as "DocReview"); kept as
> the product-and-architecture reference. UI conventions live in
> [`design-principle.md`](design-principle.md).

**Reading order / authority.** This doc captures product intent, the core
mechanisms, and the rationale behind the big decisions. The **data-layer
architecture is governed by the ADRs under [`adr/`](adr/)**, which supersede the
relevant parts of §7–§8 here:

- [ADR 0001](adr/0001-pr-data-layer-architecture.md) — Repository / Reconciler / Executor pipeline
- [ADR 0002](adr/0002-data-model.md) — `LocalState` / `RemoteState` entities, `AppState` derivation, identity
- [ADR 0003](adr/0003-operations-and-execution.md) — `ReconcileOperation` vs `ExecutionStep`
- [ADR 0004](adr/0004-reanchoring.md) — re-anchoring algorithm, `FileContent` at past shas
- [ADR 0005](adr/0005-refresh-policy.md) — refresh triggers, Snackbar as the global error surface

When an ADR and this doc disagree, the ADR wins for anything about state, storage,
operations, or re-anchoring. Code comments do not reference this doc's section
numbers (only the ADRs are referenced from code); rationale that code needs lives
in the code as self-contained comments.

---

## 1. Overview

Bark is a Chrome extension (MV3) that lets you review the Markdown documents in a
GitHub Pull Request with a Google-Docs-like feel. It renders the changed `.md`
files in full — not just the diff — and lets a reviewer drag-select any text range
to attach comments and Suggestions. Reviewer proposals land on GitHub as
Suggestions; author edits land as explicit commits.

Bark has **no backend**. All persistence is split across two layers: a **local
draft layer** (comments/Suggestions drafted in the browser) and the **GitHub API**
(the shared source of truth). Reviewer and author both look at the review through
Bark, so GitHub is only the storage/sync transport — comment positions, threads,
and history are fully reconstructed by the tool. Review and revision go back and
forth several times, so Bark makes it possible to trace _which review was answered
by which change_ and to show _what changed since last time_.

## 2. Motivation

GitHub's "Files changed" is good at line-based diffs but weak for reviewing prose
Markdown as a _document_:

- You only see changed lines, so it's hard to judge a sentence in the flow of the
  whole document.
- Comments are line-granular; "this one word in this sentence" is awkward.
- You can't review against the rendered look.

The goal is to bring the Google-Docs experience ("select and comment", "suggesting
mode") into the GitHub review workflow without breaking it.

## 3. Goals / Non-Goals

### Goals

- Review changed `.md` files in a PR, fully rendered.
- Drag-select an arbitrary text range and comment on it (range, not line).
- Create Suggestions (range replacements) that become GitHub Suggestions.
- Let the author edit the document in the web UI and commit to the PR branch by an
  explicit action.
- Draft comments/Suggestions locally and reflect them to GitHub in one batch
  (GitHub's "Start a review → Submit").
- Trace the review↔revision loop (which review was addressed by which commit).
- Visualize, in the body text, what changed since a baseline commit.
- Serverless (extension + GitHub API only).

### Non-Goals

- Real-time collaborative editing (CRDT / WebSocket). Asynchronous is enough.
- GitHub Enterprise / GHES (v1 is github.com only).
- Reviewing file formats other than Markdown.
- Non-GitHub hosts (GitLab, etc.).

## 4. Personas and primary flows

### 4.1 Reviewer

1. Click the "Open in Bark" button injected near the PR's "Files changed".
2. The extension SPA opens and renders the changed `.md`.
3. Drag-select a passage → enter a comment or Suggestion in the sidebar.
4. Findings accumulate locally as `pending` drafts.
5. "Submit review" reflects them to GitHub as a single PR review.

### 4.2 Author

1. Open the same Bark view.
2. Review the reviewer's Suggestions and edit the body directly in edit mode.
3. "Commit" writes the change to the PR's head branch.
4. Accepting a Suggestion also flows through the author's commit path.

## 5. Requirements

| ID  | Requirement                                                        | Priority |
| --- | ------------------------------------------------------------------ | -------- |
| R1  | Render changed `.md` and review the full document                  | Must     |
| R2  | Comment on an arbitrary selected range                             | Must     |
| R3  | Create a Suggestion (range replacement) → GitHub Suggestion        | Must     |
| R4  | Local draft of comments/Suggestions → batch reflect to GitHub      | Must     |
| R5  | Author edits the body → explicit commit                            | Must     |
| R6  | Import and display existing GitHub review comments                 | Should   |
| R7  | Re-anchor comments when the commit advances                        | Should   |
| R8  | Cross-file navigation across multiple `.md`                        | Could    |
| R9  | Track the review↔revision loop (reviews, commits, status timeline) | Must     |
| R10 | Visualize changes since a baseline commit in the body              | Must     |

## 6. Architecture

```
┌─────────────────────── Chrome Extension (MV3) ───────────────────────┐
│                                                                       │
│  Content Script (github.com/*/pull/*)                                 │
│    └─ Injects the "Open in Bark" entry point on the PR page           │
│                                                                       │
│  Extension SPA Page (chrome-extension://.../review.html)              │
│    ├─ Document surface   (CodeMirror 6; source canonical, live preview)│
│    ├─ Comment / Suggestion layer (selection → anchor resolution)      │
│    ├─ Editor (author edit mode)                                       │
│    └─ Review tray (list of pending drafts / Submit)                   │
│                                                                       │
│  Background Service Worker                                            │
│    ├─ Auth (device-flow token exchange; §7.6)                         │
│    └─ (CORS-restricted network calls github.com can't make from SPA)  │
│                                                                       │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ HTTPS (CORS)
                               ▼
                        api.github.com
              (PR / contents / reviews / comments)
```

- **Local layer** = drafts and precise-anchor metadata: pending comments/
  Suggestions, character-level selection ranges, settings, token.
- **GitHub** = shared source of truth: committed review comments, Suggestions,
  commits.

Because everything is asynchronous, "latest" shared state is always re-fetched
from GitHub; there is no conflict-resolution machinery for concurrent edits. See
[ADR 0001](adr/0001-pr-data-layer-architecture.md) for the runtime data flow
(`Repository` → `Reconciler` → `Executor`).

## 7. Detailed design

### 7.1 Anchoring — the core of the design

**Problem**: how do you bridge "an arbitrary character range on rendered
Markdown" and "GitHub comments, which are line-based and confined to diff hunks"?

**Approach**: treat the source Markdown as canonical and keep a **source position
map** during rendering.

1. Parse Markdown; every node carries a `position` (start/end line, column,
   offset).
2. During rendering, associate each relevant DOM node with its source offset.
3. Resolve the user's selection (a DOM/editor Range) to a source
   `{ path, startOffset, endOffset, startLine, endLine, quotedText }`.

Mapping when reflecting to GitHub:

- **Selected lines inside a PR diff hunk** → a native review comment (single line
  or `start_line`..`line`), resolving `side` (LEFT/RIGHT).
- **Outside the diff** (unchanged lines) → a normal PR comment quoting the snippet
  with a permalink (`.../blob/{sha}/{path}#Lx-Ly`). This is the default (D4).
- **Character precision**: GitHub only keeps line granularity, so GitHub's display
  rounds to lines. Bark restores the precise range itself (below).

**Full reconstruction by the tool (important, D5)**: because both reviewer and
author look at the review through Bark, it is not bound by GitHub's display
limits. Each posted comment body ends with structured metadata embedded as an
invisible HTML comment:

```text
<!-- bark:v1 {"cid":"...","path":"docs/spec.md","range":{"sl":12,"sc":4,"el":12,"ec":20},"quote":"...","sha":"abc123","thread":"t1"} -->
```

This lets Bark:

- restore a **character-level precise anchor** whether or not the selection is in
  the diff;
- group a conversation by `thread` id and render Google-Docs-style threads;
- stay readable as ordinary comments on GitHub and not break for users without
  Bark (the marker is an HTML comment, so it's hidden).

GitHub is the "storage/sync transport"; Bark is the "experience reconstruction
layer". The codec lives in `lib/metadata.ts`. If the marker is missing or
corrupt, metadata is `null` and Bark degrades to a line anchor (§12-8).

### 7.2 Comments

- Select → enter in the sidebar → save locally as `pending`.
- The persisted comment shape (identity, immutable anchor, thread, status) is
  defined by **[ADR 0002 §2](adr/0002-data-model.md)** — that is authoritative;
  the anchor is immutable and pins the comment to `(sha, range, quote)` at
  creation, which is the basis of history tracking (§7.9).
- On Submit, `POST /repos/{owner}/{repo}/pulls/{n}/reviews` carries the drafts in
  `comments[]` as one review (event `COMMENT` by default).

### 7.3 Suggestion

- The reviewer selects a range and enters the replacement source text.
- Bark resolves the target source line range and generates a Suggestion block in
  the review-comment body:
  ````text
  ```suggestion
  <replacement source lines>
  ```
  ````
- Multi-line uses `start_line`/`line`. GitHub shows an "Apply suggestion" button.
- A Suggestion outside the diff cannot be a clickable GitHub Suggestion, so it is
  demoted to a normal comment containing the proposal in a fenced block, with a
  note to that effect.

### 7.4 Author edit and commit

- The author edits the body in edit mode. **Source is canonical, and edits are
  confined to the touched range** to minimize diff noise (avoid unrelated diffs
  from re-serializing the whole document; D9).
- On "Commit":
  - single file: `PUT /repos/{owner}/{repo}/contents/{path}` (existing `sha` +
    `branch`);
  - multiple files in one commit: the Git Data API (blob → tree → commit → update
    ref).
- Accepting a Suggestion also funnels through the author's edit→commit path (the
  reviewer never rewrites the branch directly).

### 7.5 Rendering / editor technology

- **Review surface (read, comment)**: rendered Markdown + a position map. Comment
  ranges are shown as decorations (highlights).
- **Edit surface (author)**: CodeMirror 6, source with a live preview toggle, to
  keep a source-canonical editing experience.
- Full WYSIWYG (ProseMirror/TipTap) is closest to the Docs feel but produces diff
  noise on Markdown round-trips and fits PR usage poorly; deferred (see §13).

> The essence of "Docs-like" is "select and comment", "suggesting mode and
> accept/reject", and "a formatted reading experience". These are covered by the
> render surface + range anchors; full WYSIWYG is not required.

### 7.6 Auth — under the serverless constraint

- **v1**: the user issues a fine-grained PAT (`contents: read/write`, `pull
requests: read/write` on the target repos) and registers it in the extension;
  stored in `chrome.storage.local`.
- **v2 (UX, implemented)**: a **GitHub App** with the **Device Flow**. Only a
  `client_id` is needed — no client secret.
  - Disabling "Expire user authorization tokens" on the App yields a
    non-expiring user-to-server token, so no refresh is needed (and the device
    token exchange itself needs no secret). This is why a GitHub App is viable
    where an OAuth App would have needed a secret for refresh (D10).
  - A GitHub App lets the user pick repositories at install time and grant only
    `Contents` / `Pull requests` (read/write) — least privilege vs. OAuth's coarse
    `repo` scope.
  - `client_id` is injected at build time from `BARK_GITHUB_CLIENT_ID` (a public
    value, not a secret) via `.envrc.local` (direnv). Only `BARK_`-prefixed vars
    reach the bundle, keeping secrets like `GH_PAT` out.
  - **Authorization (Device Flow) and installation (repo selection) are separate
    steps.** Authorization alone doesn't install the App on the target repo, so an
    initial load can 404. When the first load is 404/403, Bark switches to a
    dedicated gate screen (like the auth gate) offering the install link
    (`https://github.com/apps/<slug>/installations/new`) and Retry. The slug comes
    from the public `BARK_GITHUB_APP_SLUG`.
- `api.github.com` returns CORS, so the token can be sent in the `Authorization`
  header directly from the browser. The github.com device endpoints
  (`/login/device/code`, `/login/oauth/access_token`) do **not** return CORS, so
  those fetches run in the background service worker (host_permissions bypasses
  CORS there).

### 7.7 Local storage

- `chrome.storage.local`: token, settings, lightweight metadata.
- IndexedDB: per-PR pending comments/Suggestions, document snapshots, position-map
  cache.
- Key design: drafts hang under `pr:{owner}/{repo}#{number}`.
- See [ADR 0002 §1](adr/0002-data-model.md) for the persisted/derived split.

### 7.8 Re-anchoring (R7)

When head advances to a new commit, saved anchors must be re-resolved against the
new source. **[ADR 0004](adr/0004-reanchoring.md) is authoritative** and supersedes
the original design: it uses `(sha)` file content + the commit diff for an exact
line map, and **eliminates the fuzzy `quotedText` search** that used to attach a
comment to the wrong line when the quote appeared more than once. When the anchor
cannot be resolved, the comment is marked `outdated` and the UI says the original
location changed.

### 7.9 Review history / rounds (R9)

Review and revision go back and forth; Bark tracks this as a timeline of
"rounds". Serverless, so history is **reconstructed from GitHub data + embedded
metadata**, not persisted.

**Rounds and sources**:

- A PR review carries `commit_id` (which commit it reviewed) and `submitted_at`
  (`GET /pulls/{n}/reviews`) — the anchor point of a round.
- Commits from `GET /pulls/{n}/commits`; diffs from `GET /compare/{base}...{head}`.
- Cross-reference these with each comment's `createdAtSha` / `thread` to build the
  timeline.

**Automatic status**:

- If a comment's anchor region changed in a commit after its `createdAtSha` →
  `addressed` (record `addressedBySha`).
- If the thread is resolved on GitHub → `resolved` (GraphQL review-thread state).
- If the region disappeared and re-anchoring failed → `outdated`.

**History view (UI)**:

```
Round 1  @ abc123  (reviewer: 5 comments / 2 suggestions)
  ├─ "Is this ambiguous?"      → addressed in def456
  ├─ "Inconsistent term"       → resolved
  └─ ...
Commit def456 (author) — 3 files changed
Round 2  @ def456  (reviewer: 1 comment)
  └─ ...
```

Each round has a baseline commit, usable as the baseline for §7.10.

### 7.10 Visualizing changes since last time (R10)

Show, overlaid on the rendered body as a redline, how the text changed from a
baseline commit to head.

- **Baseline**: default is "the sha I last viewed/reviewed". Also selectable: a
  specific round's base commit, or the PR base. Each user's last-viewed sha is
  stored locally.
- **First view**: with no prior sha there is no baseline, so no change display
  (plain rendering). The interest is "how it changed through review", not the diff
  vs. PR base; after a view is recorded, subsequent views redline against the
  previous sha (D8).
- **Diff computation**: fetch both the baseline-sha and current-head source and do
  a **client-side character/word-level diff** (e.g. diff-match-patch), finer than
  GitHub's line diff.
- **Display**: additions underlined/emphasized, deletions struck through, changes
  as replacement highlights, projected onto the DOM via the position map (§7.1).
- **Toggles**: show/hide changes, jump to changed regions only.
- When a comment's anchor overlaps a change, highlight it in concert with the
  `addressed` logic (§7.9).

## 8. Sync model

```
[local drafts] --Submit--> [GitHub review/comments/Suggestions]
[local edits]  --Commit--> [GitHub head branch]
[GitHub]       --Fetch -->  [refresh the display]
```

- Asynchronous. Re-fetch the latest from GitHub on each open.
- Conflicts: "last fetch wins". No merge of concurrent edits; on commit, a `sha`
  mismatch prompts a re-fetch.
- History (rounds) is not persisted; it is reconstructed on each fetch from
  reviews (`commit_id`/`submitted_at`), commit lists, and embedded metadata.
- The refresh trigger policy is settled by
  [ADR 0005](adr/0005-refresh-policy.md).

## 9. Security / privacy

- The token is stored in extension-local storage. Because XSS could leak it, keep
  scope/permissions minimal and provide a delete path.
- Guide users to issue fine-grained PATs limited to target repos/permissions.
- Document bodies and drafts are never sent to an external server (the no-server
  advantage).
- Sanitize rendered Markdown (`rehype-sanitize`-style) to prevent XSS.

## 10. Manifest V3 / permissions

- `host_permissions`: `https://github.com/*`, `https://api.github.com/*`.
- `permissions`: `storage` (the content script is statically declared in the
  manifest, so `scripting` is **not** needed — Chrome Web Store rejects it as
  declared-but-unused).
- Background is a service worker; split long work and persist state to IndexedDB
  since it can be terminated.
- Rate limit: 5,000 req/h authenticated. Use conditional requests (ETag) and batch
  sends to conserve.

## 11. Milestones

- **M0 (PoC)**: render a single `.md` from a PR + post one inline comment to
  GitHub.
- **M1**: arbitrary range selection + local drafts + batch Submit (R1, R2, R4).
- **M2**: Suggestions (R3), import existing comments (R6).
- **M3**: author edit + commit (R5), re-anchoring (R7).
- **M4**: change visualization (R10), review↔revision history view (R9).
- **M5**: Device Flow auth, cross-file navigation (R8).

> M0–M3 and Device Flow auth are implemented; R9/R10 (history and change
> visualization) remain the main open product work. See `CHANGELOG.md` for the
> shipped feature history.

## 12. Risks / Open Questions

1. ~~Default fallback for out-of-diff comments~~ → **decided: normal PR comment
   (quote + permalink) + embedded metadata for full reconstruction** (D4).
2. **Token storage security**: acceptability of extension-local storage;
   session-only storage or a WebAuthn gate if needed.
3. **Re-anchoring robustness**: how far it follows after force-push / rebase.
4. **Edit-mode diff noise**: at what granularity to "write back only the touched
   range".
5. **Async conflicts across reviewers**: UX of display skew from different fetch
   times.
6. **Rendering performance** for large documents / many comments.
7. ~~Default baseline for change visualization~~ → **decided: default is "my last
   viewed sha"; no change display on first view; no diff vs. PR base by
   default** (D8).
8. **Metadata tamper/loss tolerance**: fallback when the embedded metadata is
   hand-edited or deleted (degrade to a line anchor).

## 13. Alternatives considered

- **Overlay directly on GitHub's "Files changed" DOM**: stays close to the
  existing UI, but a Docs-like full-document review and arbitrary-range selection
  on the diff DOM is fragile and brittle to layout changes. Chose a dedicated SPA.
- **Keep comments purely local**: can't be shared, conflicts with R6/team use.
  Chose the "both" approach (local draft → GitHub).
- **Make full WYSIWYG (ProseMirror) canonical**: closest to the Docs experience
  but roughens the Markdown round-trip diff and hurts PR review. Chose
  source-canonical + a render surface (D9).

## 14. Decision log

The key decisions confirmed with the user, kept **with their "why"** so anyone
overturning one understands what it was protecting. When this log and the ADRs
disagree on a data-layer point, the ADRs win.

| #   | Topic                              | Decision                                                                                                           | Why                                                                                                             |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| D1  | Where comments/Suggestions persist | **Both** (local draft → batch reflect to GitHub)                                                                   | Mirror GitHub's "Start a review → Submit"; sharing happens via GitHub                                           |
| D2  | Real-time co-editing               | **Not needed** (async is fine)                                                                                     | "Docs-like" is about UX reproduction, not concurrent editing; avoid CRDT/WebSocket to stay serverless           |
| D3  | Web-UI edit results                | reviewer = **GitHub Suggestion** / author = **explicit commit**                                                    | Reviewers propose; only the author's hand finalizes — a responsibility boundary                                 |
| D4  | Comments on out-of-diff lines      | **Normal PR comment** (quote + permalink)                                                                          | GitHub review comments are confined to diff hunks; local-only was rejected as unshareable                       |
| D5  | Preserving anchor precision        | Embed **invisible metadata (HTML comment)** at the end of the comment body; Bark restores it                       | Both parties use Bark, so not bound by GitHub granularity; doesn't break on GitHub for non-Bark users           |
| D6  | Tracking review↔revision (R9)      | **Must-have**; reconstruct history each time from reviews (`commit_id`/`submitted_at`), commits, embedded metadata | The user's main interest is "how it changed through review"; reconstruct (don't persist) to stay serverless     |
| D7  | Change visualization (R10)         | **Must-have**; client-side char/word diff of baseline sha vs. head, redlined in the body                           | Same as D6; finer than line diff for prose wording changes                                                      |
| D8  | Default baseline                   | Default = **"my last viewed sha"**; **no change display on first view**; no diff vs. PR base                       | The interest is "change through review", not the full diff from base                                            |
| D9  | Canonical edit data                | **Source Markdown is canonical**; edits confined to the touched range                                              | Full-WYSIWYG Markdown round-trips roughen the PR diff (see §13)                                                 |
| D10 | Auth                               | v1 = **fine-grained PAT** / v2 = **GitHub App Device Flow** (client_id only, no secret)                            | Serverless; disabling token expiry gives a non-expiring token (no refresh); per-repo selection, least privilege |

## 15. Stakeholder concerns (don't lose these)

- The top interest is **being able to trace how the document changed through
  review**. History (R9) and change visualization (R10) are core, not decoration.
- **Serverless** is a hard constraint. Don't escape to server-based solutions
  (real-time sync, a central DB for history).
- Keep **the PR diff clean** (the background of D9): edits/commits stay minimal.
- The developer uses the tool daily; favor a straightforward fit with the
  developer workflow.

## 16. Glossary

- **Anchor**: the source range a comment/Suggestion points at (path + line/col +
  quotedText + createdAtSha).
- **Embedded metadata**: the invisible HTML comment at the end of a comment body;
  Bark reads it to restore the precise anchor, thread, and status (D5).
- **Round**: one review round-trip, anchored on a GitHub review's `commit_id`
  (R9).
- **Baseline sha**: the commit that defines "since when" for change visualization;
  default is the user's last-viewed sha (D8).
- **Canonical**: the data treated as truth. Here, **source Markdown is canonical**
  (D9).
