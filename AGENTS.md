# AGENTS.md

Guidance for AI agents working in this repository. It introduces the project,
then describes the development environment and workflow.

## Project overview

**Bark is a Chrome MV3 browser extension that brings a Google Docs–like reviewing experience to Markdown documents in GitHub Pull Requests.** Instead of GitHub's line-based "Files changed" diff, it renders the changed `.md` files in full and lets reviewers drag-select any text range to attach comments and Suggestions, while authors can edit the document in-place and commit back to the PR branch.

- **Serverless, two-layer persistence.** There is no backend. State lives in a local **draft layer** (comments/Suggestions drafted in the browser) and is reflected to **GitHub via its API** (the shared source of truth), mirroring GitHub's "Start a review → Submit" flow. The extension fully reconstructs comment positions, threads, and history on top of that.
- **Scope.** v1 targets `github.com` only (no GHES) and is asynchronous review — no real-time collaboration. See [`docs/design-doc.md`](docs/design-doc.md) for the full design and goals/non-goals (and [`docs/adr/`](docs/adr/) for the current data-layer architecture), and [`docs/design-principle.md`](docs/design-principle.md) for the UI design system.
- **Tech stack.** Built with [WXT](https://wxt.dev) (MV3 framework), React 18, and CodeMirror 6 for the editor; `react-markdown` + `rehype-sanitize` for rendering and `mermaid` for diagrams. Tooling is `bun` (runtime + test runner), `oxlint`, and `oxfmt`; tests use `@testing-library/react` on `happy-dom`.
- **Layout.** `entrypoints/` holds the extension surfaces — `background.ts`, `content.ts`, and the `review/` page (the React review UI: `App.tsx`, CodeMirror anchoring, suggestion rendering, components). `lib/` holds the shared, surface-agnostic logic — GitHub API (`github.ts`), auth (`auth.ts`), draft/comment storage (`drafts.ts`, `comments.ts`, `storage.ts`), text anchoring/re-anchoring (`anchor.ts`, `reanchor.ts`), Suggestions (`suggest.ts`), and Markdown/diff helpers. `tests/` mirrors these modules.

## Core principle

**Start from the most restrictive configuration; loosen the narrowest possible exception only when something actually breaks.** Never pre-open network hosts, permissions, or config "just in case".

## Language

**Write everything others may read in English.** This includes issues, pull
requests (titles and descriptions), commit messages, code comments, and
documentation (READMEs, design docs, etc.). Chat with the user may be in their
language, but anything committed or published to the repository or GitHub must be
in English.

## Toolchain: mise

The project toolchain (`bun`, `oxlint`, `oxfmt`, `actionlint`, `ghalint`, `zizmor`, `direnv`) is declared in `mise.toml` with pinned versions; `mise.lock` records the resolved versions (`[settings] lockfile = true`). Run `mise run setup` once after cloning.

## Development workflow

- **Develop with TDD (test-driven development).** For any feature or bugfix, follow the red-green-refactor cycle: write a failing test that captures the desired behavior, run it to confirm it fails for the right reason, write the minimum code to make it pass, then refactor with the test as a safety net. Don't write implementation code before the test exists. For a bugfix, first write a test that reproduces the bug (it should fail), then fix it. Tests run via `bun run test` (see below).
- **When a change needs the user to verify it, build first, then tell the user exactly what to check.** Don't ask the user to confirm against stale output. Produce the artifact with `bun run build`, then give concrete verification steps (e.g. "reload the extension and confirm the cursor line is no longer highlighted").
- **Run tests, lint, and format before committing.** Use the `package.json` scripts via `bun run <script>` so everyone runs the same command the CI does — don't invoke the underlying tools by hand. Don't commit changes you haven't checked.
  - `bun run test` — tests (`bun test`).
  - `bun run check:lint` — lint (`oxlint --deny-warnings`; warnings fail).
  - `bun run check:format` — format check (`oxfmt --check`); `bun run fmt` (`oxfmt --write`) to auto-fix.
  - `bun run typecheck` — type check (`tsc --noEmit`).
  - `bun run build` — build (`wxt build`).
- **Use `.local/tmp` for scratch/temporary files, not `/tmp`.** `.local/` is git-ignored, so temp files stay near the work without ever risking being committed. Create the directory if it doesn't exist.

## UI / design

- **Before changing the review UI's look and feel, read [`docs/design-principle.md`](docs/design-principle.md).** It documents Bark's design principles and token system (color, typography, spacing, radii, shadows, motion) and how to extend them cohesively. Styling is token-driven from the `:root` block in `entrypoints/review/styles.css` (the source of truth for values) — edit tokens rather than literals, preserve class names, keep the light GitHub-adjacent tone, and use no remote fonts (offline/privacy). Keep `docs/design-principle.md` in sync when the system changes.

## When the environment blocks a command

When work fails because of an environment restriction (a blocked network host, a missing tool) rather than a real bug, **do not silently work around it**. Diagnose the cause and propose the narrowest fix to the user in chat: state the symptom, the diagnosed cause, and the most specific change that would unblock the task — e.g. allowing one network host, or a `mise.toml` / setup-task change for a missing tool. The user applies environment changes; this keeps every loosening decision human-gated.

## Developer Behavior

You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.

Before writing any code, stop at the first rung that holds:

1. Does this need to be built at all? (YAGNI)
2. Does it already exist in this codebase? Reuse the helper, util, or pattern that's already here, don't re-write it.
3. Does the standard library already do this? Use it.
4. Does a native platform feature cover it? Use it.
5. Does an already-installed dependency solve it? Use it.
6. Can this be one line? Make it one line.
7. Only then: write the minimum code that works.

The ladder runs after you understand the problem, not instead of it: read the task and the code it touches, trace the real flow end to end, then climb.

Bug fix = root cause, not symptom: a report names a symptom. Grep every caller of the function you touch and fix the shared function once — one guard there is a smaller diff than one per caller, and patching only the path the ticket names leaves a sibling caller still broken.

Rules:

- No abstractions that weren't explicitly requested.
- No new dependency if it can be avoided.
- No boilerplate nobody asked for.
- Deletion over addition. Boring over clever. Fewest files possible.
- Shortest working diff wins, but only once you understand the problem. The smallest change in the wrong place isn't lazy, it's a second bug.
- Question complex requests: "Do you actually need X, or does Y cover it?"
- Pick the edge-case-correct option when two stdlib approaches are the same size, lazy means less code, not the flimsier algorithm.
- Mark intentional simplifications with a `simplify:` comment. If the shortcut has a known ceiling (global lock, O(n²) scan, naive heuristic), the comment names the ceiling and the upgrade path.

Not lazy about: understanding the problem (read it fully and trace the real flow before picking a rung, a small diff you don't understand is just laziness dressed up as efficiency), input validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs (the platform is never the spec ideal, a clock drifts, a sensor reads off), anything explicitly requested. Lazy code without its check is unfinished: non-trivial logic leaves ONE runnable check behind, the smallest thing that fails if the logic breaks (an assert-based demo/self-check or one small test file; no frameworks, no fixtures). Trivial one-liners need no test.
