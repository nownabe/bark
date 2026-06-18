# Environment improvement suggestions

A place for AI agents to record environment/sandbox limitations they hit
(per AGENTS.md "When a sandboxed command fails"). The user reviews and applies
them; agents do not edit config files directly.

---

## Sandbox cannot reach `api.github.com` → live API integration tests have no network

- **Symptom**: `bun scripts/check-integration.ts` (calls the GitHub REST API directly) fails with a network error inside the sandbox.
- **Cause**: `api.github.com` is not in `sandbox.network.allowedDomains` (currently only `registry.npmjs.org`).
- **Proposal (minimal)**: add **`api.github.com`** to `sandbox.network.allowedDomains` in `.claude/settings.json` so the extension's fetch/post logic can be integration-tested against the real API without disabling the sandbox. The token is supplied via `GH_PAT` in `.envrc.local` (direnv).

---

## Sandbox read-denies `node_modules/js-tokens` → `wxt build` fails inside the sandbox

- **Symptom**: `bun node_modules/wxt/bin/wxt.mjs build` fails with `error: Cannot find package 'js-tokens' from '.../node_modules/strip-literal/dist/index.mjs'`. The directories `node_modules/js-tokens` and `node_modules/strip-literal/node_modules/js-tokens` exist on disk, but `ls` of them returns empty inside the sandbox (content is unreadable). The same build succeeds with a one-off `dangerouslyDisableSandbox`.
- **Cause**: the sandbox `filesystem.read` denylist auto-denies paths matching a `*token*` pattern (a secret-scan heuristic). This sweeps in the legitimate `js-tokens` package (a transitive dep of `strip-literal`, used by vite/wxt during build), so the bundler cannot read it.
- **Proposal (narrowest first)**: add an `allowWithinDeny` (read) exception for exactly these two paths — `node_modules/js-tokens` and `node_modules/strip-literal/node_modules/js-tokens` — so `wxt build` works sandboxed. Do **not** broaden the `*token*` denylist removal. If other `*token*`-named packages surface in future builds (e.g. `comma-separated-tokens`, `space-separated-tokens`, already on the denylist), add each specific path the same way rather than relaxing the pattern.

---

## Sandbox read-denies `.mcp.json` → `oxfmt --check` (`bun run check:format`) fails inside the sandbox

- **Symptom**: `bun run check:format` fails inside the sandbox with `Failed to read file: .../.mcp.json` / `This may be due to the file being a binary or inaccessible.` The same check passes with a one-off `dangerouslyDisableSandbox` ("All matched files use the correct format", 69 files).
- **Cause**: `.mcp.json` is on the sandbox `filesystem.read` denylist, so oxfmt (which globs the repo root) cannot read it and aborts the whole format check.
- **Proposal (narrowest first)**: exclude `.mcp.json` from oxfmt's input rather than loosening the sandbox — e.g. add an oxfmt ignore entry / config for `.mcp.json` (it is local agent config, not project source that needs formatting). Only if oxfmt must format it should an `allowRead` exception for exactly `.mcp.json` be considered. Do **not** broaden the read denylist.

---

## `bun:test` types missing → `bun run typecheck` reports 21 errors in `tests/**` (pre-existing, not sandbox-related)

- **Symptom**: `bun run typecheck` (`tsc --noEmit`) reports 21 identical errors, one per file under `tests/`: `error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.` These persist with `dangerouslyDisableSandbox`, so they are not a sandbox masking issue. App/lib source typechecks cleanly (0 errors).
- **Cause**: neither `bun-types` nor `@types/bun` is present in `node_modules`, and `tsconfig.json` does not reference Bun's ambient types, so `tsc` cannot resolve the `bun:test` module used by every test file. (Note: CI gates are test/lint/format only — `tsc` is not run in CI — so this never fails CI, only the local `typecheck` script.)
- **Proposal (narrowest first)**: add `bun-types` as a dev dependency (`bun add -d --ignore-scripts bun-types`) and include it in `tsconfig.json` `compilerOptions.types` (e.g. `"types": ["bun-types", ...]`) or via a `/// <reference types="bun-types" />`. This makes `bun run typecheck` clean for the whole project. No sandbox change is needed.
