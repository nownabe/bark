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

- The project toolchain (`bun`, `oxlint`, `oxfmt`, `actionlint`, `ghalint`, `zizmor`, `direnv`) is declared in `mise.toml` with pinned versions; `mise.lock` records the resolved versions (`[settings] lockfile = true`). Run `mise install` to materialize them. Unlike devbox, mise installs tools under `~/.local/share/mise` instead of into the project tree, so there is nothing toolchain-related to add to `.gitignore`.
- **Launch agents with the mise toolchain active** — e.g. `mise exec -- claude`, or let `direnv` activate mise through the project `.envrc` (see `.envrc.example`) — then run `claude`.
- mise replaced devbox because devbox's Nix-profile directory symlinks (`.devbox/nix/profile/...`) made the Claude Code sandbox's bwrap initialization fail, taking down every sandboxed command. See `env-suggestion.md` for the full diagnosis.

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

| Failure symptom | Likely cause | Proposed setting (narrowest first) |
|---|---|---|
| Network/DNS/TLS error on an outbound request (`getaddrinfo`, `connection refused`, cert errors) | Domain not in the egress allowlist | Add the exact host to `sandbox.network.allowedDomains` (e.g. `registry.npmjs.org`) — never `*` |
| `Read-only file system` / permission denied on a write outside the project | Write blocked by sandbox | Add the specific path to `sandbox.filesystem.allowWrite` (e.g. a cache dir). Prefer redirecting the tool's output into the project (e.g. `BUN_INSTALL_CACHE_DIR=$PWD/.cache/bun`) over widening the sandbox |
| `No such file` / permission denied reading a path under `$HOME` | Path blocked by `denyRead: ["~/"]` | Add the specific path to `sandbox.filesystem.allowRead` (e.g. `~/.cache/<tool>`) — never re-add `~/` broadly |
| A bash command prompts every time | No matching permission rule | Add a tight `permissions.allow` rule for the exact subcommand (e.g. `Bash(bun test:*)`) |
| `Read-only file system` on `.git` | Intended: git writes must run outside the sandbox | Do **not** relax `.git` denyWrite. Ensure the command runs via `excludedCommands` (`git`/`gh`); a one-off may use `dangerouslyDisableSandbox` with user confirmation |

Rules of thumb:
- Write every proposal to `env-suggestion.md` — do not edit `.claude/settings.json`, `mise.toml`, or other config yourself. The file is the single place where all environment-improvement suggestions accumulate for the user to review.
- Each entry must propose the **most specific** change that unblocks the task (one host, one path, one subcommand) — never widen with `~/`, `/`, or `*` — and explain why it is safe. Prefer changing the tool's behavior (caches/output into the project) over loosening the sandbox.
- `dangerouslyDisableSandbox` is a last resort for genuine one-offs, always with user confirmation — not a substitute for fixing the config.
- Remember settings changes apply on the **next** session, so a settings fix needs a restart to take effect (a `dangerouslyDisableSandbox` retry can unblock the current session in the meantime).

## Reminders

- Sandbox config changes take effect on the **next** session start — restart to verify.
- The global `~/.claude/settings.json` is home-manager (Nix) managed and read-only; global changes go through the Nix config, not direct edits.
