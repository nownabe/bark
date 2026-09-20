# ADR 0005: RemoteState refresh policy and Snackbar as global error surface

- Date: 2026-06-25
- Status: Accepted
- Builds on: [ADR 0001](0001-pr-data-layer-architecture.md), [ADR 0002](0002-data-model.md), [ADR 0003](0003-operations-and-execution.md)
- Amended: 2026-09 (#267) — §2, the refresh scope covers `FileContent` at both ends of the line map.
- Amended: 2026-09 (#294) — §1/§5, manual refresh lives in the debug popover; §2, `FileContent` is refetched, not retained.

## Context

[ADR 0001](0001-pr-data-layer-architecture.md) deferred the `RemoteState` refresh trigger policy. This ADR settles it.

While designing refresh, the question of how refresh failures (and failures generally) reach the user came up. Errors are not unique to refresh — Operation failures, network errors, and auth errors share the same need. Rather than answer the question per-feature, this ADR establishes a **Snackbar as the global user-facing error surface**. Refresh just happens to be the first concrete client of that policy.

## Decision

### 1. Refresh triggers

| Trigger               | Behaviour                                                                                                                                                                                                                                                                                        | Status                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **Bootstrap**         | Full fetch on session start                                                                                                                                                                                                                                                                      | Already established by [ADR 0001](0001-pr-data-layer-architecture.md) |
| **Post-mutation**     | Executor refetches after a successful `ExecutionStep` to populate `remoteId` / `remoteThreadId` and confirm the write; a write the refetch cannot confirm falls back to `draft + lastError` and is adopted by `cid` on the next full refresh ([ADR 0003 §6–7](0003-operations-and-execution.md)) | Required for the state machine to advance `syncing → synced`          |
| **Visibility change** | When the tab returns to visible after ≥ 30 s of being hidden, full refresh                                                                                                                                                                                                                       | New                                                                   |
| **Manual (debug)**    | A Refresh button inside the debug popover (`DebugFab`) — forces a full refresh                                                                                                                                                                                                                   | Debug affordance, not a documented user feature; acceptable in v1     |

**Periodic polling is intentionally excluded.** Bark is an asynchronous review tool; users do not expect real-time updates. Polling adds cost without UX gain.

The 30 s visibility threshold avoids fetching on every brief tab switch while still refreshing for "come back tomorrow" returns. Tunable; revisit if too eager or too lazy.

### 2. Refresh scope

A full refresh refetches:

- `PullRequest` — may reveal a new `headSha`.
- `Comment` and `Thread` — for the PR.
- `FileContent` at every `(anchor.sha, path)` referenced by a Comment (fetched or local draft).
- `FileContent` at `(headSha, path)` for every such anchored `path` — re-anchoring maps `anchor.sha → headSha` and needs both ends (issues #265, #267).

The _viewed_ path is ephemeral UI state ([ADR 0002 §1](0002-data-model.md)) that the Repository does not know, so its head-sha content is **not** part of the refresh scope. The editor hook (`useSelectedFileContent`) loads it through the same `fetchFileContent`, keyed on `(headSha, path)`, so a `headSha` advance reloads the open file. Where the viewed path is also an anchored path, the hook's request is a conditional GET answered from the ETag cache (a 304 does not count against the rate limit), so the overlap costs one free round trip rather than a second download.

`User` is fetched once at bootstrap and not refreshed (it changes only on re-auth).

A full refresh **replaces** `RemoteState` wholesale (§3), `fileContents` included: every pair in the scope above is refetched, even though `FileContent` is immutable per identity. Carrying entries across a wholesale replacement would make `RemoteState` a cache with a lifetime of its own rather than a plain GitHub mirror, and the refetch is cheap: every GET the client makes carries `If-None-Match` from the in-memory ETag cache, so an unchanged blob comes back as a 304 replay that costs no rate limit. A `FileContent` cache that survives the session is a separate, still-deferred optimisation ([ADR 0004](0004-reanchoring.md), Deferred).

### 3. Refresh semantics

- **`RemoteState` is replaced wholesale** by the new snapshot. It is always a current GitHub mirror.
- **`LocalState` is merged** per the [ADR 0001 §4](0001-pr-data-layer-architecture.md) conflict policy: `synced` items are overwritten by remote; `draft` and `syncing` items are protected (except that a remote item carrying the same locally-minted id as a local item with no remote identity is adopted — [ADR 0003 §6](0003-operations-and-execution.md)); remote-deleted `synced` items are removed from `LocalState`.
- **Refreshes are serialised** at the Repository, with sync execution: fetch-and-apply and the reconcile/execute loop share one Repository-level lock, so a snapshot fetched before a write landed can never overwrite that write (issue #281). If a refresh is in flight, additional triggers coalesce: at most one queued refresh waits for the running one; further triggers share that queued refresh.

### 4. Snackbar as global error surface

Every user-relevant error — whether from refresh, Operation execution, fetches, auth, or future subsystems — is surfaced via a **transient Snackbar** at the bottom of the UI. The Snackbar shows:

- A short human-readable message (`"Could not refresh from GitHub."` / `"Failed to post comment."` etc.).
- A reason fragment when one is meaningful (status code, GitHub message).
- A close affordance; the Snackbar otherwise auto-dismisses after a few seconds.

This policy applies **across the app**, not only to refresh. Other ADRs and components should treat the Snackbar as their default error channel.

**Individual components may additionally reflect errors inline** (for example, a `Comment` in `draft + lastError` showing a retry affordance near the comment, or a sidebar entry showing an `outdated` badge). Inline reflection is a per-component judgement; the Snackbar is always used.

On refresh failure specifically:

- The previous `RemoteState` is retained (no partial-update corruption).
- A Snackbar appears with the failure reason.
- The next legitimate trigger retries automatically (no manual retry button on the Snackbar in v1).

### 5. Manual refresh (debug surface)

A manual refresh button exists for development and troubleshooting. It lives **inside the debug popover** (`entrypoints/review/components/DebugFab.tsx`): the bug-icon FAB itself is always rendered, and the Refresh button appears one click deeper, alongside the internal-state dump, only while the bootstrap has supplied a refresh function. It triggers exactly the same refresh path as the other triggers; it is not a special code path.

**Amended (2026-09, #294).** This ADR originally required the button to be hidden behind a build flag or setting. It is not: the popover is reachable in any build. That is accepted for v1 — the surrounding content is plainly a debug dump, so the button is not mistakable for a product feature, and gating it would cost the troubleshooting path the extension has no other way to offer. Promoting manual refresh to a real user feature remains deferred (below), and that is the change that would need a proper affordance rather than a hidden one.

## Consequences

### Positive

- **Predictable refresh cadence.** Only at moments the user can map to ("I just submitted", "I just came back to the tab").
- **No polling overhead.** Network and battery friendly.
- **Errors are uniformly visible.** No "silent failure" class across features — they all hit the same Snackbar.
- **One global error channel** reduces per-feature design noise.

### Negative

- **Other reviewers' comments do not appear in real time.** A reviewer typing in tab A does not see a parallel reviewer's comment in tab B until visibility-change refresh. This is consistent with Bark's async-review framing but is a behaviour change from any expectation of live collaboration.
- **The Snackbar can be missed** if the user looks away when it appears. Critical errors should be additionally surfaced inline by the affected component.
- **30 s threshold is a guess.** Real usage may want a different number.

### Deferred

- Periodic polling (v2 if needed).
- Production-grade manual refresh as a user feature (v1.x if user demand appears).
- Snackbar UX details (stacking multiple errors, retry buttons inside the Snackbar, severity styling).
- Visibility-threshold tuning based on telemetry.

## References

- [ADR 0001](0001-pr-data-layer-architecture.md) — conflict policy, state machine, failure handling.
- [ADR 0002](0002-data-model.md) — `RemoteState` shape; `FileContent` keyed by `(sha, path)`.
- [ADR 0003](0003-operations-and-execution.md) — Executor's post-mutation fetch responsibility.
