# Bark

**Google-Docs-like Markdown review for GitHub Pull Requests.** Bark is a Chrome
(MV3) extension that renders the changed `.md` files in a PR in full — not just
the diff — and lets reviewers drag-select any text range to attach comments and
Suggestions, while authors edit the document in place and commit back to the PR
branch.

Bark has **no backend**. State lives in a local draft layer (drafts in the
browser) and is reflected to **GitHub via its API** (the shared source of truth),
mirroring GitHub's "Start a review → Submit" flow. Comment positions, threads,
and history are reconstructed by the extension on top of that.

- **Scope:** `github.com` only, asynchronous review (no real-time collaboration).
- **Stack:** [WXT](https://wxt.dev) (MV3 framework), React 18, CodeMirror 6,
  `mermaid`, with `bun` as the runtime/test runner and `oxlint` / `oxfmt` for
  lint/format.

See [`docs/design-doc.md`](docs/design-doc.md) for the product and architecture
design, the [`docs/adr/`](docs/adr/) directory for the current data-layer
architecture decisions, and [`docs/design-principle.md`](docs/design-principle.md)
for the UI design system.

## Getting started

### Prerequisites

The toolchain (`bun`, `oxlint`, `oxfmt`, Node, and CI linters) is pinned in
`mise.toml`. Install [mise](https://mise.jdx.dev) and
[direnv](https://direnv.net), then materialize the toolchain:

```bash
mise install
```

`.envrc` sources the git-ignored `.envrc.local` (environment variables, see
below). With direnv active, the toolchain is on `PATH` inside the project.

`mise run setup` runs the whole setup in one step.

### Install dependencies

```bash
bun install
```

### Configure environment

Copy the example and fill in your GitHub App values (all `BARK_`-prefixed vars are
public build-time config, not secrets — only these reach the bundle):

```bash
cp .envrc.local.example .envrc.local
```

| Variable                | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `BARK_GITHUB_CLIENT_ID` | `client_id` of the GitHub App used for the device flow (§7.6)          |
| `BARK_GITHUB_APP_SLUG`  | GitHub App slug; used to build the install URL when a repo returns 404 |
| `BARK_DEV_ROLE_SWITCH`  | Dev only: set to show the floating author/reviewer role switch         |
| `GH_PAT`                | A PAT for local development (never bundled — no `BARK_` prefix)        |

### Develop

```bash
bun run dev
```

This starts WXT in dev mode and launches a Chrome instance with the extension
loaded. Open a GitHub PR with changed `.md` files and click **Open in Bark**.

### Build

Produce the unpacked extension:

```bash
bun run build   # outputs .output/chrome-mv3
```

Then load it via `chrome://extensions` → enable Developer mode → **Load unpacked**
→ select `.output/chrome-mv3`. Use `bun run zip` to produce a store-ready zip.

### Checks

Run these before committing (they mirror CI):

```bash
bun run test          # bun test
bun run check:lint    # oxlint --deny-warnings
bun run check:format  # oxfmt --check  (bun run fmt to auto-fix)
bun run typecheck     # tsc --noEmit
```

End-to-end tests use Playwright: `bun run test:e2e` (run
`bun run test:e2e:install` once to fetch the browser).

## Project layout

| Path            | What lives there                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `entrypoints/`  | Extension surfaces: `background.ts`, `content.ts`, and the `review/` SPA (the React review UI)  |
| `lib/`          | Surface-agnostic logic: GitHub API, auth, drafts/comments/storage, anchoring/re-anchoring, diff |
| `tests/`        | Tests, mirroring the modules under `lib/` and `entrypoints/`                                    |
| `docs/`         | Design doc, ADRs, design principles, release and Chrome Web Store material                      |
| `wxt.config.ts` | WXT/manifest configuration (permissions, env prefix, icons)                                     |

## Contributing

Development follows TDD and Conventional Commits; everything committed is written
in English. Read [`AGENTS.md`](AGENTS.md) for the full development workflow,
environment notes, and repository conventions before making changes.
