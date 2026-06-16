# Environment improvement suggestions

A place for AI agents to record environment/sandbox limitations they hit
(per AGENTS.md "When a sandboxed command fails"). The user reviews and applies
them; agents do not edit config files directly.

---

## Sandbox cannot reach `api.github.com` → live API integration tests have no network

- **Symptom**: `bun scripts/check-integration.ts` (calls the GitHub REST API directly) fails with a network error inside the sandbox.
- **Cause**: `api.github.com` is not in `sandbox.network.allowedDomains` (currently only `registry.npmjs.org`).
- **Proposal (minimal)**: add **`api.github.com`** to `sandbox.network.allowedDomains` in `.claude/settings.json` so the extension's fetch/post logic can be integration-tested against the real API without disabling the sandbox. The token is supplied via `GH_PAT` in `.envrc.local` (direnv).
