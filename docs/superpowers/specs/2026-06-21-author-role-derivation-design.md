# Author role derivation (issue #83)

> **Superseded (2026-09).** The role is now derived inside the data layer:
> `computeRole` in `lib/pr/appstate.ts` reads `RemoteState.viewer` against
> `PullRequest.author`, and additionally withholds `author` when
> `PullRequest.headRepo` is `null` (a deleted fork cannot be committed to,
> issue #273). The `deriveRole` helper and the `GitHubClient` lookup described
> below are gone. See [ADR 0002 §4](../../adr/0002-data-model.md) for the
> derivation rule; the reasoning here is kept as history.

## Problem

The author edit/commit flow is unreachable in normal builds. `App.tsx` defaults
`role` to `"reviewer"`, and the only control that switches to `"author"` is gated
behind `BARK_DEV_ROLE_SWITCH` (a development-only aid). The `Commit` button is
rendered only when `role === "author"`, so production users can never reach the
advertised author workflow — a core product promise (design doc §4.2, R5).

## Goal

In normal builds, derive the role automatically: a user editing their own PR
should land in author mode and see the `Commit` button, without any dev flag.

## Approach

Derive the role from identity: `role === "author"` iff the authenticated user's
GitHub login matches the PR author's login. This matches the design doc's model
(§4.2: "author" is the person who opened the PR). Everyone else stays a reviewer
and uses the Suggestion flow.

Out of scope (YAGNI): push-permission based detection (collaborators with write
access, maintainers pushing to someone else's fork via `maintainer_can_modify`),
persisting the viewer identity, and showing the viewer's avatar.

## Components

### 1. `lib/github.ts` — authenticated user lookup

Add a method to `GitHubClient`:

```
getAuthenticatedUser(): Promise<{ login: string }>
```

It calls `GET /user` using the client's existing authenticated fetch helper
(the same one `getPull` uses). Both auth methods work: a GitHub App
user-to-server token and a PAT both return the authorizing user's own profile
from `/user`.

### 2. Role derivation — pure function

Extract a pure helper so the decision is unit-testable:

```
deriveRole(viewerLogin: string | null, prAuthor: string | null): Role
```

- Returns `"author"` when both are present and equal, compared
  case-insensitively (GitHub logins are case-insensitive).
- Returns `"reviewer"` otherwise (including null/empty inputs).

Place it alongside the other review helpers (`reviewItems.ts`).

### 3. `App.tsx` — wire it in

- In the initial load effect, fetch the authenticated user alongside `getPull`,
  then `setRole(deriveRole(viewer.login, pull.author))`.
- Re-derive whenever the PR (or token) changes.
- The initial state stays `"reviewer"` until identity is known (safe default).

### 4. Error handling — reviewer fallback

If `GET /user` fails (network error, missing scope), log it and keep the role as
`"reviewer"`. The reviewer experience must not break just because the author
lookup failed; only the author-only commit affordance is withheld.

### 5. Dev switch — keep as override

`BARK_DEV_ROLE_SWITCH` stays as a development-only manual override so both modes
remain testable regardless of identity. It is hidden in normal builds, as today.
The derived role is the default the switch starts from.

## Testing (TDD)

- `deriveRole`: equal logins → author; mismatch → reviewer; case-insensitive
  match → author; null/empty → reviewer.
- `getAuthenticatedUser`: parses `login` from a mocked `/user` response (mirrors
  the existing `github.test.ts` fetch-mock pattern).

Because the `Commit` button renders directly off `role === "author"`, covering
the derivation logic establishes that the commit action becomes reachable for an
author in a production configuration (issue #83's requested check).

## Files touched

- `lib/github.ts` — new `getAuthenticatedUser` method.
- `entrypoints/review/reviewItems.ts` — new `deriveRole` pure function (+ `Role`
  import/placement as needed).
- `entrypoints/review/App.tsx` — call both in the load effect; set role from the
  derivation; reviewer fallback on error.
- `tests/github.test.ts` (or a focused test file) — `getAuthenticatedUser` and
  `deriveRole` tests.
