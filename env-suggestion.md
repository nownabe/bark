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
