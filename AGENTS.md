# AGENTS.md

Guidance for AI agents working in this repository. It introduces the project, then describes the **local development environment policy**. For the full setup plan and acceptance criteria, see issue [#1](https://github.com/nownabe/mkprev/issues/1).

## Project overview

**Bark is a Chrome MV3 browser extension that brings a Google Docs–like reviewing experience to Markdown documents in GitHub Pull Requests.** Instead of GitHub's line-based "Files changed" diff, it renders the changed `.md` files in full and lets reviewers drag-select any text range to attach comments and Suggestions, while authors can edit the document in-place and commit back to the PR branch.

- **Serverless, two-layer persistence.** There is no backend. State lives in a local **draft layer** (comments/Suggestions drafted in the browser) and is reflected to **GitHub via its API** (the shared source of truth), mirroring GitHub's "Start a review → Submit" flow. The extension fully reconstructs comment positions, threads, and history on top of that.
- **Scope.** v1 targets `github.com` only (no GHES) and is asynchronous review — no real-time collaboration. See [`docreview-design-doc.md`](docreview-design-doc.md) for the full design and goals/non-goals, and [`design.md`](design.md) for the UI design system.
- **Tech stack.** Built with [WXT](https://wxt.dev) (MV3 framework), React 18, and CodeMirror 6 for the editor; `react-markdown` + `rehype-sanitize` for rendering and `mermaid` for diagrams. Tooling is `bun` (runtime + test runner), `oxlint`, and `oxfmt`; tests use `@testing-library/react` on `happy-dom`.
- **Layout.** `entrypoints/` holds the extension surfaces — `background.ts`, `content.ts`, and the `review/` page (the React review UI: `App.tsx`, CodeMirror anchoring, suggestion rendering, components). `lib/` holds the shared, surface-agnostic logic — GitHub API (`github.ts`), auth (`auth.ts`), draft/comment storage (`drafts.ts`, `comments.ts`, `storage.ts`), text anchoring/re-anchoring (`anchor.ts`, `reanchor.ts`), Suggestions (`suggest.ts`), and Markdown/diff helpers. `tests/` mirrors these modules.

## Core principle

**Start from the most restrictive configuration; loosen the narrowest possible exception only when something actually breaks.** Autonomy comes from the sandbox boundary (filesystem + network), not from broad permission allowlists. Never pre-open paths, commands, or domains "just in case".

## Language

**Write everything others may read in English.** This includes issues, pull
requests (titles and descriptions), commit messages, code comments, and
documentation (READMEs, design docs, etc.). Chat with the user may be in their
language, but anything committed or published to the repository or GitHub must be
in English.

## Toolchain: mise

- The project toolchain (`bun`, `oxlint`, `oxfmt`, `actionlint`, `ghalint`, `zizmor`, `direnv`) is declared in `mise.toml` with pinned versions; `mise.lock` records the resolved versions (`[settings] lockfile = true`). Run `mise install` to materialize them.
- **mise installs into the project tree** (`MISE_DATA_DIR=$PWD/.local/share/mise`, set in `.envrc`), not the default `~/.local/share/mise`. This is deliberate: the sandbox only exposes the project dir (`allowRead: ["."]`), so a toolchain under `~/` would be invisible and `bun`/`oxlint`/etc. would fail with `command not found` even though they are on `PATH`. Keeping the installs in-tree puts them inside the readable boundary. Consequently `.local/` **must** be in `.gitignore` (the binaries are large and platform-specific — never commit them).
- **Launch agents with the mise toolchain active** — e.g. `mise exec -- claude`, or let `direnv` activate mise through the project `.envrc` — then run `claude`. `.envrc` is committed and must contain no secrets: it sets `MISE_DATA_DIR` and `source`s the git-ignored `.envrc.local`. Put credentials like `GH_PAT` in `.envrc.local` (copy `.envrc.local.example`).

## Development workflow

- **Develop with TDD (test-driven development).** For any feature or bugfix, follow the red-green-refactor cycle: write a failing test that captures the desired behavior, run it to confirm it fails for the right reason, write the minimum code to make it pass, then refactor with the test as a safety net. Don't write implementation code before the test exists. For a bugfix, first write a test that reproduces the bug (it should fail), then fix it. Tests run via `bun run test` (see below).
- **When a change needs the user to verify it, build first, then tell the user exactly what to check.** Don't ask the user to confirm against stale output. Produce the artifact with `bun run build`, then give concrete verification steps (e.g. "reload the extension and confirm the cursor line is no longer highlighted"). `wxt build` is configured to run outside the sandbox (the sandbox denies read access to some `node_modules` paths like `strip-literal/node_modules/js-tokens`, which breaks module resolution); if it ever lands sandboxed it fails with `Cannot find package 'js-tokens'`, so re-run it as a clean standalone command.
- **Run tests, lint, and format locally before committing.** Use the `package.json` scripts via `bun run <script>` so everyone runs the same command the CI does — don't invoke the underlying tools by hand. Don't commit changes you haven't checked.
  - `bun run test` — tests (`bun test`).
  - `bun run check:lint` — lint (`oxlint --deny-warnings`; warnings fail).
  - `bun run check:format` — format check (`oxfmt --check`); `bun run fmt` (`oxfmt --write`) to auto-fix.
  - `bun run typecheck` — type check (`tsc --noEmit`).
  - `bun run build` — build (`wxt build`); runs outside the sandbox (see the bullet above).
- **Use `.local/tmp` for scratch/temporary files, not `/tmp`.** `.local/` is git-ignored and lives inside the sandbox-readable project tree, so temp files stay within the boundary and never risk being committed. Create the directory if it doesn't exist.

## UI / design

- **Before changing the review UI's look and feel, read [`design.md`](design.md).** It documents Bark's design principles and token system (color, typography, spacing, radii, shadows, motion) and how to extend them cohesively. Styling is token-driven from the `:root` block in `entrypoints/review/styles.css` (the source of truth for values) — edit tokens rather than literals, preserve class names, keep the light GitHub-adjacent tone, and use no remote fonts (offline/privacy). Keep `design.md` in sync when the system changes.

## Sandbox (the autonomy engine)

Configured in `.claude/settings.json`. Sandboxed bash is auto-approved (`autoAllowBashIfSandboxed`) because the boundary makes it safe:

- **Read**: `denyRead: ["~/"]` + `allowRead: ["."]`. Only the project dir is visible — no credentials, shell history, or other repos.
- **Write**: project dir + temp dirs only (sandbox default), plus `.git` is fully denied (see below).
- **Network**: egress restricted to `network.allowedDomains`. This is the primary exfiltration control — even a malicious command can only reach allowlisted hosts. Keep the list minimal (e.g. GitHub, `registry.npmjs.org`) and add domains only when a real need appears.

## git / gh run OUTSIDE the sandbox

`git` and `gh` are in `excludedCommands` — they run unsandboxed because they need `~/.ssh` (SSH remote) and `~/.config/gh` (token). Their guardrail is the permission layer, not the sandbox:

- Local-only git subcommands (`add`, `commit`, `checkout`, `switch`, `branch`, `restore`, `stash`, `rebase`) → `allow`.
- `git push`, `git fetch`, `git pull` → `allow`. These are auto-approved: the remote-swap exfiltration risk that a push could carry is closed by the `.git` denyWrite (see below), not by a per-command prompt, so gating every push/fetch added friction without adding protection.
- `git remote set-url` / `git remote add` → `deny`; `git config` → `ask`.

### Invoking git / gh in practice

- **Run each `git`/`gh` as a single standalone command.** Only a command that _is_ `git`/`gh` is excluded from the sandbox; chaining it with non-git commands (`&&`, `;`, pipes, or mixing in `echo`/`touch`) makes the whole compound run sandboxed, where `.git` is read-only — git writes then fail with `fatal: Unable to create '.../.git/index.lock': Read-only file system`. One command per invocation; don't add separator/marker `echo`s.
- **If a git write hits `Read-only file system` on `.git`, it ran sandboxed**, not unsandboxed. Re-run it as a clean standalone command (a one-off `dangerouslyDisableSandbox`, with user confirmation, is the documented escape). Don't assume one approval covers the next call — retry if a call unexpectedly lands in the sandbox.
- **The unsandboxed `git status` is ground truth.** A sandboxed git view reports phantom modifications for sandbox-masked files (`.envrc`, `.claude/settings*.json`, masked workflow files) and bogus untracked `$HOME` dotfiles (`.bashrc`, `.zshrc`, `.gitconfig`, …) — none are real working-tree changes. Stage explicit paths; never `git add -A`/`git add .`.
- **To read a masked or credential-adjacent file**, use `git show HEAD:<path>` (e.g. `.envrc.local.example`) — a plain read of the working-tree file may be blocked.

## Protecting `.git` (remote-swap exfiltration)

A sandboxed, auto-approved write primitive (`sed -i`, `python`, the Edit tool) could rewrite `.git/config` to swap the `origin` URL, after which a `git push` exfiltrates to an attacker. Now that `git push` is auto-approved (see above), this `.git` denyWrite is the **sole** barrier against that swap — there is no per-push prompt to catch a tampered URL. Command-name denies do **not** close this — any write primitive works.

- **`sandbox.filesystem.denyWrite: [".git"]`** is the primary control. Deny the whole `.git`, not just `config`/`hooks` — `refs/`, `config.worktree`, `modules/`, `info/attributes`, and `index` are all dangerous if writable.
- **`permissions.deny: ["Edit(.git/**)"]`** blocks the Edit/Write tools (which bypass the bash sandbox and are auto-approved under `acceptEdits`).
- This works only because all git writes happen unsandboxed via `excludedCommands`, so denying `.git` writes in the sandbox costs nothing.

## git hooks

git hooks run as children of the unsandboxed git process, so they execute **outside the sandbox** with full privileges.

- The toolchain is on `PATH` (inherited from the mise-activated shell), so hooks can call project tools directly. Wrap them in `mise exec -- <cmd>` if the hook must also work when git is invoked outside a mise-activated shell (IDE, plain terminal, CI).
- Hooks are trusted; the safety net against planted/modified hooks is the `.git` denyWrite above.
- Do not confuse these with Claude Code's own `settings.json` hooks — those are a separate host-side mechanism.

## When a sandboxed command fails

When work fails because of a sandbox or toolchain configuration restriction (not a real bug), **do not silently fall back to `dangerouslyDisableSandbox`**. Diagnose the cause and **record the proposed fix in `env-suggestion.md`** (at the repo root) instead of changing the config yourself. Append one entry per failure: the symptom, the diagnosed cause, and the narrowest config change that would fix it, following the most-secure-first principle. The user reviews `env-suggestion.md` and applies the changes; this keeps every environment-loosening decision human-gated. Use this table to map the failure to the right setting to write down:

| Failure symptom                                                                                 | Likely cause                                      | Proposed setting (narrowest first)                                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network/DNS/TLS error on an outbound request (`getaddrinfo`, `connection refused`, cert errors) | Domain not in the egress allowlist                | Add the exact host to `sandbox.network.allowedDomains` (e.g. `registry.npmjs.org`) — never `*`                                                                       |
| `Read-only file system` / permission denied on a write outside the project                      | Write blocked by sandbox                          | Add the specific path to `sandbox.filesystem.allowWrite` (e.g. a cache dir), or redirect the tool's output into the project, rather than widening the sandbox        |
| `No such file` / permission denied reading a path under `$HOME`                                 | Path blocked by `denyRead: ["~/"]`                | Add the specific path to `sandbox.filesystem.allowRead` (e.g. `~/.cache/<tool>`) — never re-add `~/` broadly                                                         |
| A bash command prompts every time                                                               | No matching permission rule                       | Add a tight `permissions.allow` rule for the exact subcommand (e.g. `Bash(bun test:*)`)                                                                              |
| `Read-only file system` on `.git`                                                               | Intended: git writes must run outside the sandbox | Do **not** relax `.git` denyWrite. Ensure the command runs via `excludedCommands` (`git`/`gh`); a one-off may use `dangerouslyDisableSandbox` with user confirmation |

Rules of thumb:

- Write every proposal to `env-suggestion.md` — do not edit `.claude/settings.json`, `mise.toml`, or other config yourself. The file is the single place where all environment-improvement suggestions accumulate for the user to review.
- Each entry must propose the **most specific** change that unblocks the task (one host, one path, one subcommand) — never widen with `~/`, `/`, or `*` — and explain why it is safe. Prefer changing the tool's behavior (caches/output into the project) over loosening the sandbox.
- `dangerouslyDisableSandbox` is a last resort for genuine one-offs, always with user confirmation — not a substitute for fixing the config.
- Remember settings changes apply on the **next** session, so a settings fix needs a restart to take effect (a `dangerouslyDisableSandbox` retry can unblock the current session in the meantime).

## Reminders

- Sandbox config changes take effect on the **next** session start — restart to verify.

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
