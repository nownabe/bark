# Fine-grained PAT login alongside GitHub App

## Problem

Bark only authenticates through the GitHub App device flow. The user clicks
"Connect GitHub", enters a device code, and the OAuth token is stored in
`chrome.storage.local`. Some users cannot or do not want to install the Bark
GitHub App (org policy, personal preference, throwaway access) but already have,
or can quickly mint, a fine-grained Personal Access Token (PAT). There is no way
to use one today.

## Goal

Let the user choose, at login time, between **GitHub App** (the existing device
flow) and a **fine-grained PAT**. The choice screen must make each method's
characteristics clear and give exact PAT setup steps, so the user can pick the
one that fits and succeed on the first try.

## Non-goals

- **No classic PAT support.** Fine-grained only — it mirrors the GitHub App's
  per-repository, Contents + Pull requests permission model.
- **No new at-rest protection.** The PAT is stored in `chrome.storage.local`,
  exactly like today's OAuth token. No encryption, no change to storage scope.
- **No settings/account page to switch methods.** Sign-out already returns the
  user to the login choice; that is the only switch affordance.
- **No change to API calls.** `GitHubClient` already accepts any bearer token.

## Design

### Token consumption is already auth-agnostic

`GitHubClient` takes a bearer token and sets `Authorization: Bearer <token>`
regardless of origin, and `storage.ts` stores an opaque string. A validated PAT
flows through the exact same path as an OAuth token. This feature is therefore
additive: a new validation helper, an auth-method marker in storage, and a
reworked login UI.

### `lib/pat.ts` (new) — validation

```ts
export interface PatIdentity {
  login: string;
  avatarUrl: string;
}

export type PatErrorKind = "invalid" | "forbidden" | "network";

export class PatError extends Error {
  constructor(readonly kind: PatErrorKind, message: string);
}

// GET https://api.github.com/user with the candidate token.
export async function validatePat(token: string): Promise<PatIdentity>;
```

- Runs **in the page**, calling `https://api.github.com/user` directly. The
  background worker is not involved: it exists only because github.com's
  `/login/*` device endpoints omit CORS headers, whereas `api.github.com` sends
  them, so a page `fetch` works.
- `401` → `PatError("invalid", …)`. `403` → `PatError("forbidden", …)`. A thrown
  `fetch`/network failure → `PatError("network", …)`. `200` is normalized to
  `{ login, avatarUrl }` from `login` and `avatar_url`.
- The token is trimmed before use; an empty/whitespace-only input is rejected as
  `invalid` without a request.

### `lib/storage.ts` — auth-method marker

Add a marker so the rest of the app can tailor failure messaging to the method
in use:

```ts
export type AuthMethod = "app" | "pat";
export async function getAuthMethod(): Promise<AuthMethod | null>;
export async function setAuthMethod(method: AuthMethod): Promise<void>;
```

- New storage key `auth_method`.
- `clearToken()` also clears `auth_method` (sign-out resets both).
- Existing `getToken` / `setToken` / `TOKEN_KEY` are unchanged. The device flow
  path calls `setAuthMethod("app")` on success; the PAT path calls
  `setAuthMethod("pat")`.

### UI: extract `LoginGate` from `App.tsx`

The login gate is currently inline in `App.tsx` (the `ref && !token` block:
device-flow "before" and "during" screens). It grows with this feature, so
extract it into a focused component, e.g.
`entrypoints/review/components/LoginGate.tsx`, owning all pre-authentication
screens. `App.tsx` renders `<LoginGate ref={ref} onAuthenticated={…} />` and
keeps the device-flow request/poll logic it already has, passed in as props (or
moved wholesale into `LoginGate` — implementation plan decides the exact seam;
the device-flow polling effect and `slow_down`/expiry handling must not change
behavior).

`LoginGate` has three screens driven by local state
`screen: "choose" | "app" | "pat"`:

**1. `choose` — two cards (the approved 2-card layout).**

```
  Choose how to connect

  ┌─────────────┐   ┌─────────────┐
  │ GitHub App  │   │ Token (PAT) │
  │ Recommended │   │             │
  │ characteris-│   │ characteris-│
  │ tics…       │   │ tics…       │
  │ [ Connect ] │   │ [ Use → ]   │
  └─────────────┘   └─────────────┘
```

Each card lists **neutral characteristics** on the same dimensions (not
pros/cons) so the user picks what fits:

- **GitHub App** (badge: *Recommended*)
  - No expiry — access keeps working without renewal.
  - Repository access is chosen when you install the app.
  - Revoke anytime by uninstalling the app in GitHub settings.
- **Token (PAT, fine-grained)**
  - You set the expiry yourself when creating the token.
  - No app installation needed.
  - Repository access and permissions are chosen when you create the token.
  - Revoke anytime by deleting the token in GitHub settings.

`[ Connect ]` → `screen = "app"`. `[ Use → ]` → `screen = "pat"`.

**Shared privacy note.** A single message, common to both methods, is shown on
the `choose` screen (and repeated on the `pat` screen near the input): the token
(whether from the GitHub App or a PAT) is stored only in this browser
(`chrome.storage.local`) and is never sent anywhere except GitHub. This holds
for both methods, so it lives as one shared line rather than per-card text.

**2. `app` — existing device-flow screens.** Unchanged "before" (Connect GitHub)
and "during" (user code + Open GitHub + Copy) UI and logic. On authorized token:
`setToken` + `setAuthMethod("app")` → `onAuthenticated`. A back link returns to
`choose`.

**3. `pat` — PAT entry.** Contains:

- The fine-grained setup steps (exact, ordered):
  1. Open `https://github.com/settings/personal-access-tokens/new` (link, opens
     in a new tab).
  2. Repository access → **Only select repositories** → choose the PR's
     repository.
  3. Permissions → **Contents: Read and write** and **Pull requests: Read and
     write**.
  4. Generate the token, copy it, and paste it below.
- A paste field (`type="password"`, the value trimmed on submit) and
  `[ Save token ]`.
- A back link to `choose`.

Submit flow: disable the button, call `validatePat(input)`.
- Success → `setToken(token)` + `setAuthMethod("pat")` → `onAuthenticated`
  (entering the app; the resolved `login` may be shown as confirmation).
- `PatError` → inline message under the field, keeping the entered value:
  - `invalid` → "Token is invalid or expired."
  - `forbidden` → "Token lacks the required access. Check its Contents and Pull
    requests permissions."
  - `network` → "Couldn't reach GitHub. Check your connection and try again."

### Auth-method-aware install gate

The existing install gate (shown when the initial repo load returns 404/403,
linking to install the Bark app) assumes the App method. Make it method-aware:

- `auth_method === "app"` (or null/legacy) → unchanged: "Install the Bark app"
  link + retry.
- `auth_method === "pat"` → "This token can't access *{owner}/{repo}*. Check the
  token's repository access and its Contents / Pull requests permissions," with
  a control that signs out / returns to the login choice (so the user can fix or
  re-enter the token).

## Error handling summary

| Situation                         | Handling                                                        |
| --------------------------------- | --------------------------------------------------------------- |
| Empty/whitespace PAT              | Rejected as `invalid` with no network request                   |
| PAT `GET /user` → 401             | `PatError("invalid")` → "Token is invalid or expired."          |
| PAT `GET /user` → 403             | `PatError("forbidden")` → permissions hint                      |
| PAT network failure               | `PatError("network")` → connection hint                         |
| Repo load 404/403, method = pat   | Method-aware gate: token-access hint + back to login            |
| Repo load 404/403, method = app   | Unchanged install-app gate                                      |

## Testing (TDD)

- **`tests/pat.test.ts`** — `validatePat`: normalizes `200` to
  `{ login, avatarUrl }`; maps `401`→`invalid`, `403`→`forbidden`, thrown
  fetch→`network`; rejects empty input without calling fetch. Mock `fetch`.
- **`tests/storage.test.ts`** — `getAuthMethod`/`setAuthMethod` round-trip;
  `clearToken` clears both token and auth method.
- **`LoginGate` component test** (testing-library + happy-dom, via `render()`'s
  `container`, not `screen`) — `choose` renders both cards and the shared
  "stored only in this browser" note; `[ Use → ]` shows the setup steps and input; an invalid token surfaces the inline error and keeps the
  value; a valid token (mocked `validatePat`) calls `onAuthenticated`; the back
  link returns to `choose`.

CI gates are test/oxlint/oxfmt only (no tsc), so keep types clean but rely on
tests for behavior.
