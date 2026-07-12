# ADR 0005: RemoteState refresh policy and Snackbar as global error surface

- Date: 2026-06-25
- Status: Accepted
- Builds on: [ADR 0001](0001-pr-data-layer-architecture.md), [ADR 0002](0002-data-model.md), [ADR 0003](0003-operations-and-execution.md)

## Context

[ADR 0001](0001-pr-data-layer-architecture.md) deferred the `RemoteState` refresh trigger policy. This ADR settles it.

While designing refresh, the question of how refresh failures (and failures generally) reach the user came up. Errors are not unique to refresh — Operation failures, network errors, and auth errors share the same need. Rather than answer the question per-feature, this ADR establishes a **Snackbar as the global user-facing error surface**. Refresh just happens to be the first concrete client of that policy.

## Decision

### 1. Refresh triggers

| Trigger               | Behaviour                                                                                                             | Status                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Bootstrap**         | Full fetch on session start                                                                                           | Already established by [ADR 0001](0001-pr-data-layer-architecture.md) |
| **Post-mutation**     | Executor refetches after a successful `ExecutionStep` to populate `remoteId` / `remoteThreadId` and confirm the write | Required for the state machine to advance `syncing → synced`          |
| **Visibility change** | When the tab returns to visible after ≥ 30 s of being hidden, full refresh                                            | New                                                                   |
| **Manual (debug)**    | Hidden behind a debug surface (settings panel / dev flag) — force a full refresh                                      | Debug only; not a production user feature in v1                       |

**Periodic polling is intentionally excluded.** Bark is an asynchronous review tool; users do not expect real-time updates. Polling adds cost without UX gain.

The 30 s visibility threshold avoids fetching on every brief tab switch while still refreshing for "come back tomorrow" returns. Tunable; revisit if too eager or too lazy.

### 2. Refresh scope

A full refresh refetches:

- `PullRequest` — may reveal a new `headSha`.
- `Comment` and `Thread` — for the PR.
- `PrCommit` and `PrReview` — the PR's commits and reviews, from which R9 derives the review↔fix round timeline.
- `FileContent` at `(newHeadSha, currentPath)` if `headSha` advanced.
- `FileContent` at any newly-referenced `(anchor.sha, path)` introduced by newly-fetched Comments.

`User` is fetched once at bootstrap and not refreshed (it changes only on re-auth).

`FileContent` at already-fetched `(sha, path)` pairs is retained — immutable per identity.

### 3. Refresh semantics

- **`RemoteState` is replaced wholesale** by the new snapshot. It is always a current GitHub mirror.
- **`LocalState` is merged** per the [ADR 0001 §4](0001-pr-data-layer-architecture.md) conflict policy: `synced` items are overwritten by remote; `draft` and `syncing` items are protected; remote-deleted `synced` items are removed from `LocalState`.
- **Refreshes are serialised** at the Repository. If a refresh is in flight, additional triggers coalesce: at most one queued refresh waits for the running one. A later trigger does not stack, it replaces the queued one.

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

A debug-only refresh button exists for development and troubleshooting. It must not be exposed in the default user flow — typically hidden behind a settings panel, dev-build flag, or keyboard shortcut. It triggers exactly the same refresh path as the other triggers; it is not a special code path.

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
