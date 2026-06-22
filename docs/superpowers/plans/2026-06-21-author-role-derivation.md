# Author Role Derivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In normal builds, automatically put the PR's author into author mode (so the `Commit` button is reachable) by comparing the authenticated user's GitHub login to the PR author's login.

**Architecture:** Add a `getAuthenticatedUser()` method to `GitHubClient` (`GET /user`). Add a pure `deriveRole(viewerLogin, prAuthor)` helper. In `App.tsx`'s initial load effect, fetch the viewer alongside the PR and set the role from the derivation; on lookup failure, stay reviewer.

**Tech Stack:** TypeScript, React 18 (WXT extension), `bun` test runner, `oxlint`/`oxfmt`.

## Global Constraints

- Run checks via `package.json` scripts: `bun run test`, `bun run check:lint`, `bun run check:format`, `bun run typecheck`. `bun run build` runs outside the sandbox.
- All committed content (code comments, commit messages, docs) is in English.
- TDD: write the failing test first, watch it fail, then implement.
- GitHub logins are case-insensitive; compare accordingly.
- Commit related files only with explicit paths (no `git add -A`).

---

### Task 1: `deriveRole` pure helper + `Role` type

**Files:**

- Modify: `entrypoints/review/reviewItems.ts` (add `Role` type + `deriveRole`)
- Test: `tests/reviewItems.test.ts` (add a `deriveRole` describe block)

**Interfaces:**

- Produces: `export type Role = "author" | "reviewer"` and
  `export function deriveRole(viewerLogin: string | null | undefined, prAuthor: string | null | undefined): Role`

- [ ] **Step 1: Write the failing test**

Append to `tests/reviewItems.test.ts` (add `deriveRole` and `type Role` to the existing import from `"../entrypoints/review/reviewItems"` — keep the imports sorted/grouped as the file already does):

```ts
describe("deriveRole", () => {
  test("author when the viewer login equals the PR author", () => {
    expect(deriveRole("nownabe", "nownabe")).toBe("author");
  });
  test("case-insensitive match still yields author", () => {
    expect(deriveRole("NowNabe", "nownabe")).toBe("author");
  });
  test("reviewer when logins differ", () => {
    expect(deriveRole("octocat", "nownabe")).toBe("reviewer");
  });
  test("reviewer when either side is null/empty/undefined", () => {
    expect(deriveRole(null, "nownabe")).toBe("reviewer");
    expect(deriveRole("nownabe", null)).toBe("reviewer");
    expect(deriveRole("", "")).toBe("reviewer");
    expect(deriveRole(undefined, undefined)).toBe("reviewer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/reviewItems.test.ts`
Expected: FAIL — `deriveRole` / `Role` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `entrypoints/review/reviewItems.ts` (near the top, after the imports — these are pure helpers, the file's stated purpose):

```ts
/** The viewer's capability in the review UI. */
export type Role = "author" | "reviewer";

/**
 * Derive the role from identity: "author" iff the authenticated viewer's login
 * matches the PR author's login (GitHub logins are case-insensitive). Any
 * missing side falls back to "reviewer" — the safe default that withholds the
 * author-only commit affordance without breaking the reviewer flow.
 */
export function deriveRole(
  viewerLogin: string | null | undefined,
  prAuthor: string | null | undefined,
): Role {
  if (!viewerLogin || !prAuthor) return "reviewer";
  return viewerLogin.toLowerCase() === prAuthor.toLowerCase() ? "author" : "reviewer";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/reviewItems.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add entrypoints/review/reviewItems.ts tests/reviewItems.test.ts
git commit -m "feat: add deriveRole identity helper (#83)"
```

---

### Task 2: `getAuthenticatedUser` on `GitHubClient`

**Files:**

- Modify: `lib/github.ts` (add method on `GitHubClient`)
- Test: `tests/github.test.ts` (add fetch-mock helpers + a `getAuthenticatedUser` describe block)

**Interfaces:**

- Consumes: the existing private `request(path)` helper (`lib/github.ts:195`) and `GitHubClient` constructor `new GitHubClient(token)` (`lib/github.ts:173`).
- Produces: `getAuthenticatedUser(): Promise<{ login: string }>` on `GitHubClient`.

- [ ] **Step 1: Write the failing test**

`tests/github.test.ts` currently imports only pure helpers and uses no fetch mock. Add the `GitHubClient` import and the fetch-mock scaffold (mirroring `tests/pat.test.ts:1-19`), then the test. Add to the top imports:

```ts
import { afterEach, describe, expect, mock, test } from "bun:test";
import { GitHubClient } from "../lib/github";
```

Add the scaffold after the imports:

```ts
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = mock(impl) as unknown as typeof fetch;
}
function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}
```

Add the test block:

```ts
describe("getAuthenticatedUser", () => {
  test("calls /user with the bearer token and returns the login", async () => {
    let seenUrl = "";
    let seenAuth = "";
    stubFetch((url, init) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>).Authorization;
      return jsonResponse(200, { login: "octocat", id: 1 });
    });
    const user = await new GitHubClient("tok").getAuthenticatedUser();
    expect(user).toEqual({ login: "octocat" });
    expect(seenUrl).toBe("https://api.github.com/user");
    expect(seenAuth).toBe("Bearer tok");
  });

  test("throws GitHubApiError on a non-OK response", async () => {
    stubFetch(() => jsonResponse(401, {}));
    const err = await new GitHubClient("bad").getAuthenticatedUser().catch((e) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
  });
});
```

Also add `GitHubApiError` to the import from `"../lib/github"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/github.test.ts`
Expected: FAIL — `getAuthenticatedUser` is not a function.

- [ ] **Step 3: Write minimal implementation**

Add to `class GitHubClient` in `lib/github.ts`, right after `getPull` (around line 284):

```ts
  /** The authenticated user's login (`GET /user`), used to derive the author role (§7.4). */
  async getAuthenticatedUser(): Promise<{ login: string }> {
    const res = await this.request("/user");
    const json = (await res.json()) as { login?: string };
    if (!json.login) throw new GitHubApiError(res.status, "authenticated user login not found");
    return { login: json.login };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/github.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/github.ts tests/github.test.ts
git commit -m "feat: add getAuthenticatedUser to GitHubClient (#83)"
```

---

### Task 3: Wire role derivation into `App.tsx`

**Files:**

- Modify: `entrypoints/review/App.tsx` (import `Role`/`deriveRole`, remove the local `Role` type, fetch the viewer in the load effect, set the role)

**Interfaces:**

- Consumes: `deriveRole` and `Role` from `./reviewItems` (Task 1); `client.getAuthenticatedUser()` (Task 2); the existing load effect at `App.tsx:443-469`.

- [ ] **Step 1: Import `Role` and `deriveRole`; drop the local `Role` type**

In `entrypoints/review/App.tsx`, add `Role` and `deriveRole` to the existing import block from `"./reviewItems"` (the block spanning lines ~36-53; keep the alphabetical-ish grouping the file uses — add `deriveRole` among the value imports and `type Role` among the type imports).

Then delete the now-duplicate local declaration at line 102:

```ts
type Role = "author" | "reviewer";
```

(Leave `type ViewMode = "raw" | "preview";` on the next line intact.)

- [ ] **Step 2: Fetch the viewer and set the role in the load effect**

In the load effect's `try` block (`App.tsx:449-464`), after `setSelectedPath(...)` (line 458), add a nested guarded lookup so a `/user` failure cannot break the reviewer load:

```ts
setSelectedPath((prev) => prev ?? md[0]?.path ?? null);
try {
  const viewer = await client.getAuthenticatedUser();
  if (!cancelled) setRole(deriveRole(viewer.login, info.author));
} catch (identityError) {
  // Identity lookup failed (network / missing scope). Stay reviewer:
  // only the author-only commit affordance is withheld; the reviewer
  // flow is unaffected. (#83)
  console.warn("Bark: author-role lookup failed", identityError);
}
```

- [ ] **Step 3: Typecheck, lint, format, test**

Run each and expect success:

```bash
bun run typecheck
bun run check:lint
bun run check:format
bun run test
```

Expected: all pass. (`check:format` failing → run `bun run fmt` and re-check.)

- [ ] **Step 4: Build and verify manually**

`bun run build` runs OUTSIDE the sandbox (clean standalone command):

```bash
bun run build
```

Then tell the user to verify: load the unpacked extension, open a PR you authored, and confirm the **Commit** button appears (author mode); open a PR authored by someone else and confirm it does not (reviewer mode, Submit/Discard shown instead).

- [ ] **Step 5: Commit**

```bash
git add entrypoints/review/App.tsx
git commit -m "fix: derive author role from identity so commit flow is reachable (#83)"
```

---

## Self-Review

- **Spec coverage:** §1 `getAuthenticatedUser` → Task 2. §2 `deriveRole` → Task 1. §3 wiring in the load effect → Task 3 Step 2. §4 reviewer fallback → Task 3 Step 2 (nested try/catch). §5 dev switch kept → unchanged (no task touches `DEV_ROLE_SWITCH`). Testing section → Tasks 1 & 2 unit tests; Task 3 Step 4 manual verification.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `Role` and `deriveRole` signatures match across Tasks 1 and 3; `getAuthenticatedUser(): Promise<{ login: string }>` matches its use in Task 3 (`viewer.login`). `info.author` is `PullInfo.author: string` (`lib/github.ts:99`).
