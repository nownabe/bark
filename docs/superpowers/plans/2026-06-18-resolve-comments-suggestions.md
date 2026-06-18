# Resolve comments & suggestions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let reviewers/authors resolve Bark comment & suggestion threads (accepted suggestions count as resolved automatically), with a multi-select filter to view pending / sent / resolved items.

**Architecture:** Resolved state is stored as hidden `bark:v1` metadata on GitHub via append-only "resolution event" comments (reconstructed from the REST comment lists). In-diff threads additionally get GitHub's native `resolveReviewThread` as a one-way mirror. The sidebar's single-select filter becomes a multi-select facet set (`pending`/`submitted`/`resolved`), defaulting to pending+submitted.

**Tech Stack:** TypeScript, WXT, React 18, `bun:test`. GitHub REST + GraphQL.

## Global Constraints

- Test runner: `bun run test` (`bun test`). Lint: `bun run check:lint`. Format: `bun run check:format` (`bun run fmt` to fix). Types: `bun run typecheck`. Build: `bun run build` (outside sandbox).
- TDD: write the failing test first, watch it fail, then implement.
- All committed text (code, comments, messages) in English.
- Conventional Commits; assignee `nownabe` on the eventual PR; PR base branch is `main`.
- Work happens on branch `feat/resolve-comments` (already created off `origin/main`).
- Stage explicit paths in git (never `git add -A`/`.`). Run each `git` call as a standalone command.
- Metadata SoT: resolution markers are comments whose `meta.event` is set; they are never rendered as thread messages.

---

### Task 1: Metadata `event` field

**Files:**
- Modify: `lib/metadata.ts` (the `CommentMetadata` interface)
- Test: `tests/metadata.test.ts`

**Interfaces:**
- Produces: `CommentMetadata.event?: "resolve" | "unresolve"` — present only on resolution-marker comments.

- [ ] **Step 1: Write the failing test**

Add to `tests/metadata.test.ts` inside the `describe("metadata", ...)` block:

```typescript
test("round-trips the resolution event field", () => {
  const ev: CommentMetadata = { ...meta, cid: "c-evt", event: "resolve" };
  const r = extractMetadata(embedMetadata("Resolved via Bark.", ev));
  expect(r.body).toBe("Resolved via Bark.");
  expect(r.meta).toEqual(ev);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test 2>&1 | grep -A3 "resolution event"`
Expected: FAIL — `event` is not assignable / not part of `CommentMetadata` (typecheck) or value mismatch.

- [ ] **Step 3: Add the field**

In `lib/metadata.ts`, inside `interface CommentMetadata`, after the `kind?` line, add:

```typescript
  /** Set only on resolution-marker comments; toggles a thread's resolved state. */
  event?: "resolve" | "unresolve";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test`
Expected: PASS (all metadata tests green).

- [ ] **Step 5: Typecheck & commit**

```bash
bun run typecheck
git add lib/metadata.ts tests/metadata.test.ts
git commit -m "feat(metadata): add resolution event field to CommentMetadata"
```

---

### Task 2: Derive `resolved` in the review-items model

**Files:**
- Modify: `entrypoints/review/reviewItems.ts` (`ReviewThread`, `buildThreads`)
- Test: `tests/reviewItems.test.ts`

**Interfaces:**
- Consumes: `CommentMetadata.event` (Task 1).
- Produces:
  - `ReviewThread.resolved: boolean`
  - `buildThreads(comments, drafts, currentPath, opts?: { accepted?: (commentId: number) => boolean }): ReviewThread[]` — resolution-event comments are excluded from `messages`/root selection and instead set `resolved`; a thread whose root is a suggestion for which `opts.accepted(rootId)` is true is also `resolved`.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `tests/reviewItems.test.ts` (the `comment`/`meta`/`draft` helpers already exist in the file):

```typescript
describe("buildThreads resolved state", () => {
  const evt = (id: number, thread: string, event: "resolve" | "unresolve") =>
    comment({ id, meta: { ...meta(5, "a.md", thread), cid: `e${id}`, event } });

  test("a resolve event marks the thread resolved and is not shown as a message", () => {
    const [t] = buildThreads(
      [comment({ id: 1, meta: meta(5, "a.md", "t1") }), evt(2, "t1", "resolve")],
      [],
      "a.md",
    );
    expect(t.resolved).toBe(true);
    expect(t.messages).toHaveLength(1); // only the root, not the event
  });

  test("latest event wins: unresolve after resolve re-opens", () => {
    const [t] = buildThreads(
      [
        comment({ id: 1, meta: meta(5, "a.md", "t1") }),
        evt(2, "t1", "resolve"),
        evt(3, "t1", "unresolve"),
      ],
      [],
      "a.md",
    );
    expect(t.resolved).toBe(false);
  });

  test("an accepted suggestion thread is resolved", () => {
    const [t] = buildThreads(
      [comment({ id: 1, meta: { ...meta(5, "a.md", "t1"), kind: "suggestion" } })],
      [],
      "a.md",
      { accepted: (id) => id === 1 },
    );
    expect(t.resolved).toBe(true);
  });

  test("threads default to not resolved", () => {
    const [t] = buildThreads([comment({ id: 1, meta: meta(5, "a.md", "t1") })], [], "a.md");
    expect(t.resolved).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test 2>&1 | grep -A3 "resolved state"`
Expected: FAIL — `resolved` is `undefined`; `buildThreads` rejects the 4th argument (typecheck).

- [ ] **Step 3: Implement**

In `entrypoints/review/reviewItems.ts`:

Add `resolved` to the interface (after `hasSubmitted: boolean;`):

```typescript
  hasSubmitted: boolean;
  /** Resolved via a resolution event, or root is an accepted suggestion. */
  resolved: boolean;
```

Replace the `buildThreads` function with:

```typescript
export function buildThreads(
  comments: ExistingComment[],
  drafts: PendingDraft[],
  currentPath: string,
  opts?: { accepted?: (commentId: number) => boolean },
): ReviewThread[] {
  const order: string[] = [];
  const groups = new Map<string, { submitted: ExistingComment[]; pending: PendingDraft[] }>();
  const group = (key: string) => {
    let g = groups.get(key);
    if (!g) {
      g = { submitted: [], pending: [] };
      groups.set(key, g);
      order.push(key);
    }
    return g;
  };
  // Resolution events are hidden markers: collect the latest per thread, but keep
  // them out of the visible messages/root.
  const latestEvent = new Map<string, { id: number; event: "resolve" | "unresolve" }>();
  for (const c of comments) {
    if (c.meta?.event) {
      const t = c.meta.thread;
      const prev = latestEvent.get(t);
      if (!prev || c.id > prev.id) latestEvent.set(t, { id: c.id, event: c.meta.event });
      continue;
    }
    group(c.meta?.thread || `solo:${c.source}:${c.id}`).submitted.push(c);
  }
  for (const d of drafts) group(d.thread).pending.push(d);

  const list: ReviewThread[] = order.map((id) => {
    const g = groups.get(id)!;
    const submitted = [...g.submitted].sort((a, b) => a.id - b.id);
    const pending = g.pending;
    const rootComment = submitted[0] ?? null;
    const rootDraft = pending[0] ?? null;
    const messages: ThreadMessage[] = [
      ...submitted.map((comment): ThreadMessage => ({ kind: "submitted", comment })),
      ...pending.map((draft): ThreadMessage => ({ kind: "pending", draft })),
    ];
    const resolvedByEvent = latestEvent.get(id)?.event === "resolve";
    const acceptedSuggestion =
      rootComment?.meta?.kind === "suggestion" && (opts?.accepted?.(rootComment.id) ?? false);
    return {
      id,
      messages,
      rootComment,
      rootDraft,
      path: rootComment?.meta?.path ?? rootComment?.path ?? rootDraft?.path,
      pos: threadPos(rootComment, rootDraft),
      quote: rootComment?.meta?.quote ?? rootDraft?.quote,
      hasPending: pending.length > 0,
      hasSubmitted: submitted.length > 0,
      resolved: resolvedByEvent || acceptedSuggestion,
    };
  });
  list.sort((a, b) => rank(a.path, currentPath) - rank(b.path, currentPath) || a.pos - b.pos);
  return list;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test`
Expected: PASS (new `resolved state` tests + existing `buildThreads` tests green).

- [ ] **Step 5: Typecheck & commit**

```bash
bun run typecheck
git add entrypoints/review/reviewItems.ts tests/reviewItems.test.ts
git commit -m "feat(review): derive thread resolved state from events and accepts"
```

---

### Task 3: Multi-select facet filter

**Files:**
- Modify: `entrypoints/review/reviewItems.ts` (`ReviewFilter` → `ReviewFacet`, `filterReviewEntries`, `reviewEntryCounts`)
- Test: `tests/reviewItems.test.ts`

**Interfaces:**
- Consumes: `ReviewThread.resolved` (Task 2).
- Produces:
  - `type ReviewFacet = "pending" | "submitted" | "resolved"` (replaces `ReviewFilter`; `"all"` removed)
  - `filterReviewEntries(entries: ReviewEntry[], facets: Set<ReviewFacet>): ReviewEntry[]`
  - `reviewEntryCounts(entries: ReviewEntry[]): { pending: number; submitted: number; resolved: number }`

- [ ] **Step 1: Update existing tests + add new ones (failing)**

In `tests/reviewItems.test.ts`, replace the three filter tests (the `'pending'`, `'submitted'`, `'all'` tests around lines 209-223) with:

```typescript
  test("'pending' shows threads with pending content + live suggestions", () => {
    const pending = filterReviewEntries(entries, new Set(["pending"] as const));
    expect(pending).toHaveLength(3); // t1 (pending reply) + new (pending) + live
  });

  test("'submitted' shows only threads that have submitted comments", () => {
    const submitted = filterReviewEntries(entries, new Set(["submitted"] as const));
    expect(submitted).toHaveLength(1);
    expect(submitted[0].kind === "thread" && submitted[0].thread.id).toBe("t1");
  });

  test("pending+submitted is the union of the two facets", () => {
    expect(filterReviewEntries(entries, new Set(["pending", "submitted"] as const))).toHaveLength(3);
  });
```

Replace the `reviewEntryCounts` test (around lines 248-262) with:

```typescript
describe("reviewEntryCounts", () => {
  test("pending/submitted/resolved derive from the current-file entries", () => {
    const comments = [comment({ id: 1, meta: meta(5, "a.md", "t1") })];
    const drafts = [draft({ cid: "d1", thread: "t1", range: { sl: 5, sc: 1, el: 5, ec: 5 } })];
    const threads = buildThreads(comments, drafts, "a.md");
    const entries = buildReviewEntries({
      threads,
      pendingSuggestions: [liveSuggestion],
      currentPath: "a.md",
    });
    const counts = reviewEntryCounts(entries);
    expect(counts.pending).toBe(2); // t1 pending reply + live suggestion
    expect(counts.submitted).toBe(1); // t1 has a submitted comment
    expect(counts.resolved).toBe(0);
  });

  test("resolved threads count under resolved and drop out of pending/submitted", () => {
    const comments = [
      comment({ id: 1, meta: meta(5, "a.md", "t1") }),
      comment({ id: 2, meta: { ...meta(5, "a.md", "t1"), cid: "e2", event: "resolve" } }),
    ];
    const threads = buildThreads(comments, [], "a.md");
    const entries = buildReviewEntries({ threads, pendingSuggestions: [], currentPath: "a.md" });
    const counts = reviewEntryCounts(entries);
    expect(counts.submitted).toBe(0);
    expect(counts.resolved).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test 2>&1 | grep -A3 -i "facet\|resolved threads count\|union"`
Expected: FAIL — `filterReviewEntries`/`reviewEntryCounts` still take the old `ReviewFilter` string and expose `all`.

- [ ] **Step 3: Implement**

In `entrypoints/review/reviewItems.ts`, replace the `ReviewFilter` type declaration:

```typescript
export type ReviewFacet = "pending" | "submitted" | "resolved";
```

Replace `filterReviewEntries`:

```typescript
export function filterReviewEntries(
  entries: ReviewEntry[],
  facets: Set<ReviewFacet>,
): ReviewEntry[] {
  return entries.filter((e) => {
    if (e.kind === "liveSuggestion") return facets.has("pending");
    const t = e.thread;
    if (facets.has("resolved") && t.resolved) return true;
    if (facets.has("pending") && t.hasPending && !t.resolved) return true;
    if (facets.has("submitted") && t.hasSubmitted && !t.resolved) return true;
    return false;
  });
}
```

Replace `reviewEntryCounts`:

```typescript
export function reviewEntryCounts(entries: ReviewEntry[]): {
  pending: number;
  submitted: number;
  resolved: number;
} {
  const count = (f: ReviewFacet) => filterReviewEntries(entries, new Set([f])).length;
  return { pending: count("pending"), submitted: count("submitted"), resolved: count("resolved") };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test`
Expected: PASS. (App.tsx will not typecheck yet — that is fixed in Task 5. Tests run on the lib/model only, so `bun run test` is green.)

- [ ] **Step 5: Commit**

```bash
git add entrypoints/review/reviewItems.ts tests/reviewItems.test.ts
git commit -m "feat(review): make the sidebar filter a multi-select facet set"
```

---

### Task 4: GitHub client — resolve API + thread lookup

**Files:**
- Modify: `lib/github.ts` (add `ReviewThreadInfo`, `findThreadNodeId`, and `GitHubClient` methods)
- Test: `tests/github.test.ts`

**Interfaces:**
- Produces:
  - `interface ReviewThreadInfo { id: string; isResolved: boolean; commentIds: number[] }`
  - `findThreadNodeId(threads: ReviewThreadInfo[], commentId: number): string | null` (pure)
  - `GitHubClient.listReviewThreads(ref: PrRef): Promise<ReviewThreadInfo[]>`
  - `GitHubClient.resolveReviewThread(threadId: string): Promise<void>`
  - `GitHubClient.unresolveReviewThread(threadId: string): Promise<void>`
  - `GitHubClient.replyToReviewComment(ref: PrRef, inReplyTo: number, body: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Add to `tests/github.test.ts`:

```typescript
import { findThreadNodeId, type ReviewThreadInfo } from "../lib/github";

describe("findThreadNodeId", () => {
  const threads: ReviewThreadInfo[] = [
    { id: "PRRT_1", isResolved: false, commentIds: [10, 11] },
    { id: "PRRT_2", isResolved: true, commentIds: [20] },
  ];
  test("returns the node id of the thread containing the comment", () => {
    expect(findThreadNodeId(threads, 11)).toBe("PRRT_1");
    expect(findThreadNodeId(threads, 20)).toBe("PRRT_2");
  });
  test("returns null when no thread contains the comment", () => {
    expect(findThreadNodeId(threads, 99)).toBeNull();
  });
});
```

Add `findThreadNodeId` and `ReviewThreadInfo` to the import block at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test 2>&1 | grep -A3 "findThreadNodeId"`
Expected: FAIL — `findThreadNodeId` / `ReviewThreadInfo` not exported.

- [ ] **Step 3: Implement the pure helper + types**

In `lib/github.ts`, after the `RawIssueComment` interface, add:

```typescript
/** A GitHub review thread (GraphQL) reduced to what resolve needs. */
export interface ReviewThreadInfo {
  /** GraphQL node id, the target of resolve/unresolve mutations. */
  id: string;
  isResolved: boolean;
  /** REST databaseId of each comment in the thread. */
  commentIds: number[];
}

/** Map a root review comment's REST id to its thread's GraphQL node id (null if none). */
export function findThreadNodeId(threads: ReviewThreadInfo[], commentId: number): string | null {
  for (const t of threads) if (t.commentIds.includes(commentId)) return t.id;
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test 2>&1 | grep -A3 "findThreadNodeId"`
Expected: PASS.

- [ ] **Step 5: Add the client methods (no unit test — network)**

In `lib/github.ts`, inside `class GitHubClient`, add a GraphQL helper after the `post` method:

```typescript
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API_BASE}/graphql`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw this.errorFor(res, "graphql");
    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (json.errors) {
      throw new GitHubApiError(res.status, `GraphQL error: ${JSON.stringify(json.errors)}`);
    }
    return json.data as T;
  }
```

Then add the public methods after `listIssueComments`:

```typescript
  /** Review threads (node id + isResolved + member comment databaseIds), paginated. */
  async listReviewThreads(ref: PrRef): Promise<ReviewThreadInfo[]> {
    const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$number){
          reviewThreads(first:100,after:$cursor){
            nodes{ id isResolved comments(first:100){ nodes{ databaseId } } }
            pageInfo{ hasNextPage endCursor }
          }
        }
      }
    }`;
    type Resp = {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: { id: string; isResolved: boolean; comments: { nodes: { databaseId: number | null }[] } }[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
    };
    const all: ReviewThreadInfo[] = [];
    let cursor: string | null = null;
    do {
      const data: Resp = await this.graphql<Resp>(query, {
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        cursor,
      });
      const conn = data.repository.pullRequest.reviewThreads;
      for (const n of conn.nodes) {
        all.push({
          id: n.id,
          isResolved: n.isResolved,
          commentIds: n.comments.nodes
            .map((c) => c.databaseId)
            .filter((id): id is number => id != null),
        });
      }
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);
    return all;
  }

  /** Mark a review thread resolved (native mirror of the metadata SoT). */
  async resolveReviewThread(threadId: string): Promise<void> {
    await this.graphql(
      `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id } } }`,
      { id: threadId },
    );
  }

  /** Re-open a previously resolved review thread. */
  async unresolveReviewThread(threadId: string): Promise<void> {
    await this.graphql(
      `mutation($id:ID!){ unresolveReviewThread(input:{threadId:$id}){ thread{ id } } }`,
      { id: threadId },
    );
  }

  /** Post a reply inside an existing review thread (carries the resolution marker). */
  async replyToReviewComment(ref: PrRef, inReplyTo: number, body: string): Promise<void> {
    await this.post(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`, {
      body,
      in_reply_to: inReplyTo,
    });
  }
```

- [ ] **Step 6: Verify & commit**

```bash
bun run typecheck
bun run test
git add lib/github.ts tests/github.test.ts
git commit -m "feat(github): add review-thread resolve API and thread lookup"
```

---

### Task 5: Wire resolve/reopen into the review UI

**Files:**
- Modify: `entrypoints/review/App.tsx`
- Modify: `entrypoints/review/styles.css` (multi-select chip + resolved badge)
- Reference: `design.md` (read before the chip restyle; keep tokens/classes consistent)

**Interfaces:**
- Consumes: `ReviewFacet`, `filterReviewEntries`, `reviewEntryCounts` (Task 3); `buildThreads` accepted option (Task 2); `embedMetadata`/`CommentMetadata` (Task 1); `findThreadNodeId`, `listReviewThreads`, `resolveReviewThread`, `unresolveReviewThread`, `replyToReviewComment` (Task 4).

> No unit tests: App.tsx is not unit-tested in this project (CI gates are test/lint/format). Verify with `typecheck`, `build`, and the manual steps below.

- [ ] **Step 1: Read the design system**

Run: `Read entrypoints/review/styles.css` `:root` block and `design.md` to find the existing `.seg` chip tokens and badge classes. Reuse them; do not introduce new literals.

- [ ] **Step 2: Imports**

In `entrypoints/review/App.tsx`:
- In the `reviewItems` import block, change `type ReviewFilter,` to `type ReviewFacet,`.
- Ensure these are imported from `../../lib/github`: `findThreadNodeId`. (Add to the existing github import.)
- Ensure `embedMetadata` is imported from `../../lib/metadata` and `type CommentMetadata` is available (add `embedMetadata` to the metadata import).

- [ ] **Step 3: Filter state → facet set**

Replace the filter state declaration (line ~164):

```typescript
  const [reviewFilter, setReviewFilter] = useState<Set<ReviewFacet>>(
    () => new Set<ReviewFacet>(["pending", "submitted"]),
  );
```

Add a toggle helper near the other handlers:

```typescript
  const toggleFacet = (f: ReviewFacet) =>
    setReviewFilter((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
```

- [ ] **Step 4: Pass accepted into buildThreads**

Replace the `threads` memo (lines ~243-246):

```typescript
  const threads = useMemo(
    () => buildThreads(comments, drafts, curPath, { accepted: (id) => dismissed[id] === "accepted" }),
    [comments, drafts, curPath, dismissed],
  );
```

- [ ] **Step 5: Fix the two "make emphasized item visible" calls**

Replace both `setReviewFilter("all");` calls (lines ~1068 and ~1087) with:

```typescript
      setReviewFilter(new Set<ReviewFacet>(["pending", "submitted", "resolved"]));
```

- [ ] **Step 6: Resolve / reopen handlers**

Add near `addReply` (it has `ref`, `client`, `headSha`, `setReloadKey` in scope):

```typescript
  // Post a resolution-event comment (hidden metadata SoT) and, for in-diff
  // threads, mirror it with GitHub's native resolve. Immediate; then reload.
  const setThreadResolved = async (t: ReviewThread, resolved: boolean) => {
    if (!ref || !headSha) return;
    const root = t.rootComment;
    if (!root?.meta) return;
    const evMeta: CommentMetadata = {
      cid: crypto.randomUUID(),
      path: root.meta.path,
      range: root.meta.range,
      quote: root.meta.quote,
      sha: headSha,
      thread: t.id,
      kind: "comment",
      event: resolved ? "resolve" : "unresolve",
    };
    const body = embedMetadata(resolved ? "Resolved via Bark." : "Reopened via Bark.", evMeta);
    if (root.source === "review") {
      await client.replyToReviewComment(ref, root.id, body);
      const nodeId = findThreadNodeId(await client.listReviewThreads(ref), root.id);
      if (nodeId) {
        if (resolved) await client.resolveReviewThread(nodeId);
        else await client.unresolveReviewThread(nodeId);
      }
    } else {
      await client.createIssueComment(ref, body);
    }
    setReloadKey((k) => k + 1);
  };
```

- [ ] **Step 7: Resolve / Reopen button in `renderThread`**

In `renderThread` (near the `showAuthorActions` block, ~line 1356), compute eligibility and render a control. A thread is event-resolvable when it has a Bark root comment with a submitted comment. Reopen is shown only when resolution came from an event (not from accepting a suggestion):

```typescript
    const acceptedRoot = root?.meta?.kind === "suggestion" && dismissed[root.id] === "accepted";
    const canResolve = Boolean(root?.meta) && t.hasSubmitted && !acceptedRoot;
```

Then, inside the thread's actions area, add:

```tsx
        {canResolve ? (
          <div className="comment__actions">
            {t.resolved ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={(e) => {
                  e.stopPropagation();
                  void setThreadResolved(t, false);
                }}
              >
                Reopen
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={(e) => {
                  e.stopPropagation();
                  void setThreadResolved(t, true);
                }}
              >
                Resolve
              </button>
            )}
          </div>
        ) : null}
```

(Use the button classes that already exist in `styles.css`; if `btn--ghost`/`btn--sm` don't exist, reuse the classes the Accept/Reject buttons use.)

- [ ] **Step 8: Multi-select filter chips**

Replace the filter `seg` block (lines ~1672-1683) with:

```tsx
              <div className="seg seg--sm">
                {(["pending", "submitted", "resolved"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={reviewFilter.has(f)}
                    onClick={() => toggleFacet(f)}
                  >
                    {f === "pending" ? "Pending" : f === "submitted" ? "Sent" : "Resolved"} ({counts[f]})
                  </button>
                ))}
              </div>
```

- [ ] **Step 9: Pass the facet set to the filter**

`visibleEntries` already calls `filterReviewEntries(entries, reviewFilter)` — now `reviewFilter` is a `Set<ReviewFacet>`, so no change is needed beyond Step 3. Confirm `reviewEntryCounts` usage (`counts.pending` etc.) compiles with the new shape.

- [ ] **Step 10: Optional resolved badge**

If `design.md` has a badge token, render a small `resolved` badge on resolved threads' root message (reuse the existing `badge` class). Keep it minimal; skip if no clean token exists.

- [ ] **Step 11: Typecheck, lint, format, build**

```bash
bun run typecheck
bun run check:lint
bun run check:format
bun run build
```

Expected: all pass; `build` produces the extension (run outside the sandbox).

- [ ] **Step 12: Manual verification**

Tell the user to reload the unpacked extension and, on a PR review page:
1. On a submitted comment thread, click **Resolve** → the thread leaves the default (Pending/Sent) view; selecting the **Resolved** chip shows it; on GitHub the in-diff thread is collapsed/resolved with a "Resolved via Bark." reply.
2. Click **Reopen** on a resolved thread → it returns to the Sent view; GitHub thread is un-resolved.
3. Accept a suggestion → it appears under **Resolved** (no Reopen button).
4. Toggle chips: Pending-only, Resolved-only, and Pending+Sent+Resolved combinations show the expected items; counts match.

- [ ] **Step 13: Commit**

```bash
git add entrypoints/review/App.tsx entrypoints/review/styles.css
git commit -m "feat(review): resolve/reopen threads and multi-select filter UI"
```

---

## Self-review notes

- **Spec coverage:** metadata `event` (T1); resolution-event reconstruction + accepted=resolved (T2); multi-facet filter incl. `all` removal (T3); GraphQL resolve/unresolve + reply + `findThreadNodeId` (T4); immediate resolve/reopen, native mirror for in-diff, chips, eligibility, emphasize-fix (T5). Out-of-scope items (non-Bark threads, reading native isResolved, bulk resolve) are intentionally omitted.
- **Type consistency:** `ReviewFacet` replaces `ReviewFilter` everywhere; `buildThreads` 4th arg `{ accepted }` matches App's call; `findThreadNodeId(ReviewThreadInfo[], number)` matches client usage; `setThreadResolved` uses `setReloadKey` (existing reload trigger).
- **Note for executor:** confirm button class names against `styles.css` in Task 5 Step 7 (the plan names `btn--ghost btn--sm` as a guess — fall back to the Accept/Reject button classes if absent).
