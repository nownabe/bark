# AGENTS.md

Guidance for AI agents working in this repository. This file describes the **local development environment policy**. For the full setup plan and acceptance criteria, see issue [#1](https://github.com/nownabe/mkprev/issues/1).

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

## Sandbox (the autonomy engine)

Configured in `.claude/settings.json`. Sandboxed bash is auto-approved (`autoAllowBashIfSandboxed`) because the boundary makes it safe:

- **Read**: `denyRead: ["~/"]` + `allowRead: ["."]`. Only the project dir is visible — no credentials, shell history, or other repos.
- **Write**: project dir + temp dirs only (sandbox default), plus `.git` is fully denied (see below).
- **Network**: egress restricted to `network.allowedDomains`. This is the primary exfiltration control — even a malicious command can only reach allowlisted hosts. Keep the list minimal (e.g. GitHub, `registry.npmjs.org`) and add domains only when a real need appears.

## git / gh run OUTSIDE the sandbox

`git` and `gh` are in `excludedCommands` — they run unsandboxed because they need `~/.ssh` (SSH remote) and `~/.config/gh` (token). Their guardrail is the permission layer, not the sandbox:

- Local-only git subcommands (`add`, `commit`, `checkout`, `switch`, `branch`, `restore`, `stash`, `rebase`) → `allow`.
- `git push` → `ask`. This is the one human-gated point: read the full command (especially the URL) before approving.
- `git fetch` / `git pull` → pin to the remote name (`git fetch origin`, `git pull origin`); arbitrary-URL fetches must not be auto-approved.
- `git remote set-url` / `git remote add` → `deny`; `git config` → `ask`.

### Invoking git / gh in practice

- **Run each `git`/`gh` as a single standalone command.** Only a command that *is* `git`/`gh` is excluded from the sandbox; chaining it with non-git commands (`&&`, `;`, pipes, or mixing in `echo`/`touch`) makes the whole compound run sandboxed, where `.git` is read-only — git writes then fail with `fatal: Unable to create '.../.git/index.lock': Read-only file system`. One command per invocation; don't add separator/marker `echo`s.
- **If a git write hits `Read-only file system` on `.git`, it ran sandboxed**, not unsandboxed. Re-run it as a clean standalone command (a one-off `dangerouslyDisableSandbox`, with user confirmation, is the documented escape). Don't assume one approval covers the next call — retry if a call unexpectedly lands in the sandbox.
- **The unsandboxed `git status` is ground truth.** A sandboxed git view reports phantom modifications for sandbox-masked files (`.envrc`, `.claude/settings*.json`, masked workflow files) and bogus untracked `$HOME` dotfiles (`.bashrc`, `.zshrc`, `.gitconfig`, …) — none are real working-tree changes. Stage explicit paths; never `git add -A`/`git add .`.
- **To read a masked or credential-adjacent file**, use `git show HEAD:<path>` (e.g. `.envrc.local.example`) — a plain read of the working-tree file may be blocked.

## Protecting `.git` (remote-swap exfiltration)

A sandboxed, auto-approved write primitive (`sed -i`, `python`, the Edit tool) could rewrite `.git/config` to swap the `origin` URL, after which an approved `git push` exfiltrates to an attacker. Command-name denies do **not** close this — any write primitive works.

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
