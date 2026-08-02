---
name: pr
description: Create a pull request for the current session's work. Verifies the branch is appropriate (no open/merged/closed PR conflict, branching from main when needed), runs all pre-commit checks (test, lint, format, typecheck, build), commits related files using Conventional Commits with a why-focused body, and opens a PR with a Conventional-Commit title and a concise why/what body.
model: sonnet
---

# Create a Pull Request

Guide the work that turns the current session's changes into a reviewable pull
request. Move through the four stages below **in order**. Stop and ask the user
whenever a decision is ambiguous or a step would discard or overwrite work.

Write everything that lands in git or GitHub — commit messages, PR title, PR
body — in **English** (project policy). Chat with the user may be in their
language.

## Prerequisites

- Stage **explicit paths** only. Never `git add -A` / `git add .`.

## Stage 1 — Confirm the branch is appropriate

1. Get the current branch and its state:
   - `git branch --show-current` — current branch name.
   - `git status` — working tree state.
   - `git log --oneline main..HEAD` — commits unique to this branch (adjust base
     if the project's default branch differs; this repo's PR base is `main`).
2. Check whether a PR already exists for this branch:
   - `gh pr list --head <branch> --state all --json number,state,title,url`
3. Decide based on what you find:
   - **No PR, branch is not the default branch** → this branch is fine; continue.
   - **An open PR exists** → adding commits to this branch updates that PR. Decide
     whether the session's work belongs in that PR (same logical change) or
     deserves a **separate** PR. If separate, branch off a fresh base (below).
     When unclear, ask the user.
   - **A merged or closed PR exists for this branch** → do **not** reuse it.
     Create a new branch from the up-to-date base.
   - **Currently on the default branch (`main`)** → never commit directly. Create
     a new branch first.
4. When a new branch is needed:
   - `git fetch origin` to update the base.
   - Branch from the latest base, usually `main`:
     `git switch -c <type>/<short-topic> origin/main`
     (use a Conventional-Commit-style prefix: `feat/…`, `fix/…`, `chore/…`,
     `docs/…`, `refactor/…`).
   - If changes are already in the working tree, switching carries them along;
     verify with `git status` afterward.

## Stage 2 — Run all pre-commit checks

Run the `package.json` scripts (same commands CI runs) so nothing is committed
unchecked. Run each as its own command and fix failures before continuing:

- `bun run test` — tests.
- `bun run check:lint` — lint (warnings fail).
- `bun run check:format` — format check (`bun run fmt` to auto-fix).
- `bun run typecheck` — type check.
- `bun run build` — build.

If a check fails for a real bug, fix it and re-run. If it fails because of an
environment restriction (not a real bug), follow the repo policy: propose the
narrowest fix to the user rather than working around it silently.

## Stage 3 — Commit the session's related files

1. Review exactly what changed: `git status` and `git diff` (and
   `git diff --staged` once staged).
2. Stage only files **related to this session's work**, by explicit path:
   `git add <path> <path> …`. Leave unrelated or incidental changes (e.g. local
   config files) unstaged. If the working tree mixes unrelated changes, ask the
   user how to split them rather than lumping everything into one commit.
3. Commit with a **Conventional Commits** message:
   - Subject: `<type>(<optional scope>): <imperative summary>` — `feat`, `fix`,
     `chore`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`, `style`.
   - Body: explain the **why** — the problem or motivation behind the change, not
     a restatement of the diff. Wrap at ~72 columns.
   - Prefer a single focused commit; split into multiple commits when the work
     covers genuinely distinct concerns.
   - Pass the message with multiple `-m` flags (one per paragraph) to keep it a
     single standalone `git commit` command. Do not author commits with the Bash
     heredoc/`cat` pattern.

## Stage 4 — Open the pull request

1. Push the branch: `git push -u origin <branch>` (auto-approved here).
2. Create the PR with `gh pr create`:
   - `--title` in **Conventional Commits** format (mirror the primary commit
     subject).
   - `--body` concise, covering **why** (motivation/context) and **what** (the
     change at a high level). A short bulleted "what" is fine.
   - `--base main` (this repo's PR base), `--head <branch>`.
   - `--assignee nownabe` (global policy: always assign `nownabe`).
   - Provide the body via a file to keep formatting clean. Use a
     **branch-name-scoped** path so concurrent agents don't collide: write it to
     `.local/tmp/pr-body-<branch>.md` (replace `/` in the branch name with `-`)
     in the git-ignored scratch dir (create `.local/tmp` if missing) with the
     Write tool, then `gh pr create --body-file .local/tmp/pr-body-<branch>.md …`.
3. After creation, report the PR URL to the user. If an open PR was updated
   instead of created, link that PR and note it was updated.
4. **Clean up** the temporary body file once the PR is created:
   `rm -f .local/tmp/pr-body-<branch>.md`.

## Stage 5 — Watch CI and fix failures

After the PR is open, watch its CI checks to green. If a check fails, fix the
cause, commit, and let CI re-run — repeat until checks pass.

1. Watch the checks to completion (blocks until all required checks finish):
   - `gh pr checks <pr-number> --watch` — live status; exits non-zero if any
     required check fails.
   - Run this as a single standalone `gh` command.
2. If everything passes → report success with the PR URL and stop.
3. If a check fails, inspect the failure before changing anything:
   - `gh pr checks <pr-number>` — see which check failed and its run URL.
   - For Actions logs, use the `@nownabe/claude-tools` helpers (run via
     `bunx @nownabe/claude-tools …`): `gh list-run-jobs <run_id>` to find the
     failed job, then `gh get-job-logs <job_id>` for its logs.
4. Diagnose, then act on the cause:
   - **A real failure** (lint, format, type, test, or build error CI caught) →
     fix it in the code. Reproduce and confirm with the matching local check from
     Stage 2 (`bun run check:lint`, `bun run fmt`, `bun run test`,
     `bun run typecheck`, `bun run build`) before committing.
   - **A flaky or infra failure** (network blip, transient runner error) → re-run
     the failed jobs instead of editing code: `gh run rerun <run_id> --failed`.
5. Commit the fix on the same branch with a Conventional Commits message whose
   body explains **why** (what CI caught), then `git push`. Stage only the files
   you changed, by explicit path.
6. Re-watch with `gh pr checks <pr-number> --watch`. Loop steps 3–6 until checks
   pass. If the same check keeps failing after a couple of attempts, or the fix
   is ambiguous or risky, stop and ask the user instead of churning commits.

## Body template

```
## Why

<the motivation: problem, context, or goal this change serves>

## What

- <high-level change 1>
- <high-level change 2>
```
