# ADR 0002: Data model — LocalState entities, AppState derivation, and identity strategy

- Date: 2026-06-24
- Status: Accepted
- Companion: [ADR 0001 — PR data flow](0001-pr-data-layer-architecture.md) scopes the _how_ (Repository, Reconciler, Executor, state machine, conflict policy). This ADR scopes the _what_ (entity shapes, fields, layering, identity).

## Context

[ADR 0001](0001-pr-data-layer-architecture.md) established the data-flow pipeline (`LocalState` / `RemoteState`, `PullRequestReconciler`, `PullRequestOperationExecutor`) and the entity state machine (`draft` / `syncing` / `synced`) but explicitly deferred entity field schemas and the layering between persisted state and React.

This ADR fixes the data model. The driving design question was where to draw the line between **persisted data** (which has its own identity and must round-trip through GitHub or `chrome.storage.local`) and **application-convenient data** (which exists for the UI's benefit and can be either transient or derivable). The model below answers that explicitly.

## Decision

### 1. Three layers

```
LocalState   ← persisted; only true data lives here
   │
   │ pure-function derivation
   ▼
AppState     ← in-memory view model for the UI
   │
   ▼
React components
```

- **`LocalState`** contains only data with its own identity and a state-machine lifecycle. It is persisted to `chrome.storage.local`.
- **`AppState`** is a derived view model computed from `LocalState` and `RemoteState` (the latter supplies `PullRequest`, `User`, and `FileContent` as inputs). It holds _everything_ the UI conveniently needs that can be derived from those, plus ephemeral UI state (selection, hover, filters, the currently-viewed path).
- React components read from `AppState`. They never read directly from `LocalState`. Some components (notably the editor in reviewer mode) hold additional component-local buffers — see §6.

### 2. Entity rules

Every persisted entity follows the same shape:

```
{
  id: LocalId                          // generated at creation; primary identity
  state: 'draft' | 'syncing' | 'synced'
  lastError?: ErrorInfo                // set when last sync attempt failed
  remote*?: ...                        // remote identifier(s), undefined while draft
  ...domain fields
}
```

- **`LocalId` is the primary identity** for every entity. Remote identifiers (GitHub REST `remoteId`, GraphQL `remoteThreadId`) are supplementary and populated by the Executor on successful sync.
- **Structure does not change across states.** A `draft` entity has the same field set as a `synced` one; only `state` and the optional remote identifiers differ. This was an explicit decision to avoid the asymmetric-shape bugs we saw in the legacy model.
- **No state-conditional fields.** Anything role-, mode-, or kind-conditional that _can_ be derived from `body` or other fields is not stored. It is computed in `AppState` (see §4).
- **Creation-time data is immutable.** Once set, anchors and other "set at creation" fields are never mutated by reconciliation, refresh, or display logic. Display-time recomputation (such as re-anchoring) is a derivation in `AppState`, not a mutation of the persisted entity.

### 3. Entities and the `PRState` shape

`LocalState` and `RemoteState` share a single `PRState` shape so the Reconciler can diff them field-by-field; individual fields are conventionally populated on one side or the other (e.g. `fileEdits` lives in `LocalState`, `pullRequest`/`viewer`/`fileContents` come from GitHub via `RemoteState`).

````ts
type User = {
  login: string;
  avatarUrl?: string;
};

type Comment = {
  id: LocalId;
  state: "draft" | "syncing" | "synced";
  lastError?: ErrorInfo;

  remoteId?: number; // GitHub REST comment id
  remoteKind?: "review" | "issue"; // which GitHub object remoteId names; set together with it
  threadId: LocalId; // parent Thread.id (always set)
  parentLocalId?: LocalId; // reply target within the same thread

  body: string; // includes ```suggestion fence if any
  author: User;

  path: string;
  anchor: {
    // immutable, set at creation
    sha: string;
    range: { sl: number; sc: number; el: number; ec: number };
    quote: string;
  };
};

type Thread = {
  id: LocalId;
  state: "draft" | "syncing" | "synced";
  lastError?: ErrorInfo;

  remoteThreadId?: string; // GraphQL node id (review threads); needed for resolveReviewThread
  remoteIssueCommentId?: number; // REST id of the root issue comment (out-of-diff threads)
  resolved: boolean;
  viewerCanResolve?: boolean; // remote-derived: the viewer may toggle `resolved`; undefined while draft
};

type FileEdit = {
  // author mode only; transient
  id: LocalId;
  state: "draft" | "syncing"; // no 'synced' — entity is removed on success
  lastError?: ErrorInfo;

  path: string;
  baseSha: string;
  editedSource: string;
  resolveOnCommit?: LocalId[]; // Threads to resolve once this edit is committed (accepted suggestions)
};

type PullRequest = {
  owner: string;
  repo: string;
  number: number;

  title: string;
  body: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  author: User;
};

type FileContent = {
  sha: string;
  path: string;
  source: string;
};

type PRState = {
  comments: Comment[];
  threads: Thread[];
  fileEdits: FileEdit[];
  fileContents: FileContent[];
  pullRequest: PullRequest | null;
  viewer: User | null;
};

type LocalState = PRState;
type RemoteState = PRState;
````

Field-by-field, which side conventionally populates each:

| Field          | `LocalState`                                | `RemoteState`                                               |
| -------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `comments`     | drafts + last-known synced                  | mirror of GitHub                                            |
| `threads`      | drafts + last-known synced (resolve intent) | mirror of GitHub (incl. GraphQL `isResolved`)               |
| `fileEdits`    | pending author edits                        | always empty                                                |
| `fileContents` | always empty                                | fetched per `(sha, path)` ([ADR 0004](0004-reanchoring.md)) |
| `pullRequest`  | always `null`                               | the PR being viewed                                         |
| `viewer`       | always `null`                               | the current authenticated user                              |

`FileEdit` is the one mutating entity that does not retain a `synced` state. After a successful commit, its information is fully captured by `RemoteState`'s `fileContents` and the entity is removed. Its draft and syncing states have identical shape, satisfying the consistency rule.

`PullRequest`, `viewer`, and `fileContents` are read-only mirrors of GitHub; the Reconciler does not diff them against `LocalState`. They are fetched at bootstrap (and refreshed on demand per the refresh policy) and treated as input by the Executor.

> **Amendment (2026-07-22).** `RemoteState` additionally carries an optional `changedFiles?: ChangedFile[]` — the `GET /pulls/{n}/files` listing already fetched every refresh for in-diff routing ([ADR 0003 §5](0003-operations-and-execution.md) treats the current diff as "part of `RemoteState`") — so `AppState` can derive the changed-`.md` file selector from the Repository. It is deliberately **not** part of the shared `PRState` shape: the Reconciler never diffs it, `LocalState` never populates it, and the unified-diff patches must not be persisted to `chrome.storage.local`. This is the one intentional exception to `RemoteState = PRState`.

A `Thread` has exactly one remote identity: `remoteThreadId` for a GitHub review thread, or `remoteIssueCommentId` for an out-of-diff thread whose comments are issue comments (which have no GraphQL thread). Both are absent while the thread is a local draft.

A `Thread` is created together with its root `Comment`: upserting a top-level draft Comment inserts a `draft` Thread with the same id (`Comment.threadId`), which then follows the Comment's transitions. Replies never create Threads. A Thread with no remaining Comments and no remote identity is removed with its last Comment.

`viewerCanResolve` is a mirrored fact like `resolved`: the fetcher derives it from the viewer's repository permission (`permissions.push` on `GET /repos/{o}/{r}`) plus GitHub's ownership rule — the PR author may resolve review threads; the root comment's author may rewrite an out-of-diff root; write access covers both. The Reconciler ignores it; the UI hides Resolve/Reopen when it is not `true`.

A synced `Comment` records `remoteKind`, the endpoint its `remoteId` belongs to (a pull-request review comment or a flat issue comment). It is set when the comment is fetched or when its post succeeds, and it is what routes replies ([ADR 0003 §3](0003-operations-and-execution.md)): GitHub issue comments have no reply endpoint, and the two REST ids are indistinguishable integers.

`User` is a single value-object type used wherever a GitHub identity appears — `Comment.author`, `PullRequest.author`, and `PRState.viewer`. There is no GitHub-side user table to normalise against; the inlined form stays small and avoids reference indirection.

### 4. Derived data (`AppState`)

The following are computed from `LocalState` and _must not_ be stored:

| Derived value                     | Computed from                                                        |
| --------------------------------- | -------------------------------------------------------------------- |
| `kind: 'comment' \| 'suggestion'` | presence of ` ```suggestion ` fence in `Comment.body`                |
| `replacement: string`             | parsed suggestion fence content                                      |
| thread tree for the UI            | `Comment.threadId` + `Comment.parentLocalId`                         |
| current-source display position   | `Comment.anchor` + `FileContent` at `(headSha, path)` (re-anchoring) |
| `inDiff` per Comment              | current PR diff + `Comment.anchor.range`                             |
| `role: 'author' \| 'reviewer'`    | `User.login` vs `PullRequest.author.login`                           |
| current `headSha` / `headRef`     | `PullRequest.headSha` / `PullRequest.headRef`                        |
| "is this my draft"                | `Comment.state === 'draft'`                                          |

`AppState` also holds **ephemeral UI state** — current selection, hovered thread, sidebar filter, current path, etc. None of it is persisted.

Derivations that need GitHub-side data (notably re-anchoring, which needs the file content at past commits) read from `RemoteState.FileContent`, not from a separate AppState cache.

### 5. Identity matching

The Executor embeds entity identity into the wire format so it survives the GitHub round trip:

- For each submitted `Comment`, the Executor embeds `{ cid: Comment.id, thread: Comment.threadId }` (plus the anchor) as base64-encoded hidden metadata in the comment body, exactly as the legacy implementation does.
- On `RemoteState` fetch, the Executor extracts this metadata and pre-populates `Comment.id` / `Thread.id` so the Reconciler can match remote items to local ones structurally.
- `Thread.remoteThreadId` is resolved by joining GraphQL `reviewThreads` data with the matched `Comment` set (any comment in a remote thread that maps to a known `Thread.id` tells us the `remoteThreadId` for that `Thread`).
- For out-of-diff threads there is no GraphQL thread to join. The thread's identity is its root issue comment — the earliest comment bearing its `threadId` (the same ownership rule that binds `cid`s) — and its `resolved` state is read from that comment's hidden metadata (`resolved` in the envelope).

The hidden metadata envelope (its layout, base64 encoding, version field) is the Executor's private concern. It is not visible to `LocalState`, `AppState`, the Reconciler, or React.

### 6. Reviewer-mode editor buffer

The reviewer's editor buffer (the in-progress edited source of a Markdown file) is **not** modeled as a `LocalState` entity. It lives in component-local React state in the editor component.

- The component holds the live editor source.
- At appropriate moments (debounce, blur, explicit save, submit), the component diffs the buffer against the base source and **materialises** the resulting hunks as `Comment`s with `state: 'draft'` and a ` ```suggestion ` body — adding, updating, or removing them in `LocalState` to match the current set of hunks.
- On page reload, the component reconstructs its editor buffer by applying the persisted draft suggestion bodies to the base source.

Trade-off: any partial replacement the reviewer has typed but not yet "saved" to a Comment is lost on reload. Mitigation is the component's responsibility (frequent auto-save, blur-triggered save, etc.).

This keeps `LocalState` focused on entities that round-trip through GitHub and leaves the live-editing UX entirely to the editor component.

### 7. What is removed from the legacy model

- **`kind` field on Comment** — derived from `body`.
- **`suggestion` (replacement) field on Comment** — derived from `body`.
- **Reviewer-side `SourceDraft`** — replaced by component-local buffer + draft `Comment`s.
- **`RejectedSuggestions`** — rejection is now expressed as "Thread is resolved without a corresponding commit", in diff and out of diff alike. GitHub is the source of truth (GraphQL `isResolved`, or the root comment's `resolved` metadata); Bark does not maintain a parallel local-only rejection set.
- **`PendingDraft` / `CommentMetadata` / `ExistingComment`** — three legacy representations of a single concept, collapsed into one `Comment` with a `state` field.
- **`event: 'resolve'` marker comments** — superseded by direct GraphQL `isResolved` reads for review threads and, for out-of-diff (issue-comment) threads, by a `resolved` flag in the root comment's own hidden metadata that the Executor rewrites in place. Neither path posts a comment.

## Consequences

### Positive

- **One representation per concept.** The legacy three-way `PendingDraft` / `CommentMetadata` / `ExistingComment` split is gone.
- **Structure-consistent states.** A `draft` and a `synced` `Comment` have the same shape, so generic code (selectors, renderers, the Reconciler) does not branch on lifecycle state.
- **`LocalState` is small and disciplined.** Only data with identity and a sync lifecycle lives there. Everything UI-shaped is in `AppState`.
- **GitHub is the sole source of truth for thread resolution.** No more dual-write-with-divergence between Bark resolve markers and GraphQL `isResolved`. Out-of-diff threads store it on GitHub too (root-comment metadata), so a fresh fetch reconstructs every thread's state.
- **Hidden metadata is fully encapsulated** inside the Executor. Higher layers see plain entity fields only.
- **The model survives a UX rewrite.** Editor buffer details are component-local; changing the editor doesn't change the persisted model.

### Negative / costs

- **Reviewer auto-save responsibility moves to the component.** Partial typed replacements can be lost across reload unless the component saves aggressively. This is a UX-quality concern to be designed into the editor component.
- **Identity propagation through GraphQL joins requires Executor effort.** Stitching `remoteThreadId` to local `Thread.id` via the contained `Comment`s is an extra step every fetch. It is encapsulated, but it does exist.
- **A reply chain involving multiple drafts requires ordered execution.** The Executor must post the parent first, learn its `remoteId`, then post the child with `in_reply_to`. This sequencing belongs to the Operation specification (deferred).

### Deferred

- The Component-side reviewer-editor auto-save policy.

The `Operation` catalog is specified in [ADR 0003](0003-operations-and-execution.md). The re-anchoring algorithm is specified in [ADR 0004](0004-reanchoring.md). The refresh policy and Snackbar error surface are specified in [ADR 0005](0005-refresh-policy.md). No data-migration plan is required (pre-release): legacy `chrome.storage.local` keys (`drafts`, `suggestion-edits`, `dismissed-suggestions`) and legacy hidden-metadata payloads in test data are dropped rather than migrated.

## References

- [ADR 0001](0001-pr-data-layer-architecture.md) — the surrounding data-layer architecture.
- `/.local/tmp/architecture-data-model.md` — the legacy-model audit that motivated this work (not committed).
