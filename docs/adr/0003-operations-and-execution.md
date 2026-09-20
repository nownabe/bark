# ADR 0003: ReconcileOperation and ExecutionStep — the two-layer change pipeline

- Date: 2026-06-25
- Status: Accepted
- Builds on: [ADR 0001](0001-pr-data-layer-architecture.md), [ADR 0002](0002-data-model.md)
- Amended: 2026-09 (#294) — §7, legacy `bark:v1` metadata is read, not discarded.

## Context

[ADR 0001](0001-pr-data-layer-architecture.md) introduced `PullRequestReconciler` and `PullRequestOperationExecutor` and deferred the catalog of what flows between them. [ADR 0002](0002-data-model.md) fixed the entity shapes that the catalog has to express. This ADR fills the gap.

A single name "Operation" was originally going to cover both "what the Reconciler produces" and "what the Executor runs", but these are different shapes of data: the Reconciler thinks at the entity-diff grain (one Comment created, one Thread resolved) while the Executor has to deal with GitHub API constraints (one review POST must atomically carry N comments; one commit fans into blob/tree/commit/updateRef). Conflating them either gave the Reconciler API knowledge it shouldn't have, or forced the Executor to recover entity-level batching from a fine-grained stream.

This ADR splits the two concepts.

## Decision

### 1. Two layers

- **`ReconcileOperation`** is what `PullRequestReconciler` emits. Fine-grained, one-per-entity-diff, independent. The Reconciler does not know about GitHub APIs, batching, or ordering.
- **`ExecutionStep`** is what `PullRequestOperationExecutor` runs. API-shaped. May bundle many `ReconcileOperation`s (when the API is atomic), or may fan one Op into several HTTP calls (when one logical change requires a sequence). The Executor owns batching, ordering, atomicity, and hidden-metadata serialization.

The mapping is many-to-many in principle but constrained in practice: most Ops map 1:1 to a Step; a few common cases bundle (review batch) or fan (commit).

### 2. Reconciler — emission rules

The Reconciler runs whenever `LocalState` changes. For each entity diff, it emits at most one `ReconcileOperation`:

- **Comment in `syncing` without `remoteId`, `parentLocalId` absent** → `CreateComment`.
- **Comment in `syncing` without `remoteId`, `parentLocalId` present and parent is `synced`** → `CreateReply`.
- **Comment in `syncing` with `parentLocalId` whose parent is not yet `synced`** → no Op emitted this cycle; the parent's `CreateComment` will sync first, and the next cycle re-evaluates. If the parent never reaches `synced` within the invocation, the reply is swept back to `draft` at the end (§6).
- **`Thread.resolved` differs from `RemoteState`, state is `syncing`, and the thread has a remote identity (`remoteThreadId` or `remoteIssueCommentId`)** → `UpdateThreadResolved` (carrying the desired boolean and that identity). A thread without either has not been created on GitHub yet and emits nothing.
- **`FileEdit` in `syncing`** → `CommitFileEdit`.

The Reconciler does not look at multiple entities to decide what to emit. Whether two `CreateComment`s become one review batch is the Executor's call.

### 3. Executor — planning and ordering

The Executor receives a `ReconcileOperation[]` per Reconciler cycle and plans `ExecutionStep[]`. It is responsible for:

- **Batching.** All `CreateComment` Ops targeting in-diff anchors collapse into one `PostReviewBatch`. Out-of-diff `CreateComment`s become one `PostIssueComment` each. A `CreateReply` maps 1:1 to `PostReply` when its parent is a review comment (`parent.remoteKind === "review"`) and to `PostIssueComment` when the parent is an issue comment (`"issue"`): issue comments are flat, so the reply is another issue comment that Bark ties to the thread by its metadata `threadId`. Routing reads the parent's recorded kind and never consults the current diff — a parent's creation-time lines drift out of (or into) the diff after later pushes, which is exactly the misrouting issue #285 fixed. No batch API exists for replies.
- **Ordering.** Steps within one cycle are independent and may run in any order. The one cross-entity dependency — a suggestion accepted into a `FileEdit` must not be resolved unless that edit was committed — is not a step-ordering rule but a state transition: `FileEdit.resolveOnCommit` lists the Threads, and a successful `Commit` flips them `synced → syncing (resolved: true)` so the next cycle emits their `UpdateThreadResolved`. A failed `Commit` leaves them untouched (issue #278). Steps never interleave with a `RemoteState` refresh ([ADR 0005 §3](0005-refresh-policy.md)).
- **Atomicity.** `PostReviewBatch` is atomic by GitHub design. `Commit` is multi-call but the Executor treats it as one atomic Step: a failure at any sub-call fails the whole Step.
- **Identity round-trip.** The Executor embeds `{ cid, threadId, anchor }` as base64 hidden metadata in any comment body it posts, and extracts the same on fetch.

### 4. `ReconcileOperation` catalog

| Op                     | Inputs (from `LocalState`)                                                         | Trigger                                   |
| ---------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| `CreateComment`        | `Comment` (state=syncing, remoteId absent, parentLocalId absent)                   | top-level draft Comment submitted         |
| `CreateReply`          | `Comment` + parent `Comment` (parent must be synced)                               | reply draft submitted with synced parent  |
| `UpdateThreadResolved` | `threadId`, `desiredResolved: boolean`, `remoteThreadId` \| `remoteIssueCommentId` | `Thread.resolved` toggled and now syncing |
| `CommitFileEdit`       | `FileEdit` (path, baseSha, editedSource)                                           | `FileEdit` flipped to syncing             |

That's the complete set. No `AcceptSuggestionOp`, no `AuthorSubmitOp`, no `DeleteCommentOp`, no `UpdateCommentBodyOp` — features that don't exist as separate state changes don't need their own Op.

### 5. `ExecutionStep` catalog

| Step                     | Inputs                                                                               | Bundles                                           | GitHub API                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PostReviewBatch`        | in-diff `CreateComment[]`                                                            | many `CreateComment`s sharing the same submission | `POST /repos/.../pulls/{n}/reviews` (one call, atomic)                                                                                                                           |
| `RejectComment`          | one unmappable `CreateComment`                                                       | 1:1                                               | none — fails locally (see below)                                                                                                                                                 |
| `PostReply`              | one `CreateReply` whose parent is a review comment                                   | 1:1                                               | `POST /repos/.../pulls/{n}/comments` with `in_reply_to`                                                                                                                          |
| `PostIssueComment`       | one out-of-diff `CreateComment`, or a `CreateReply` whose parent is an issue comment | 1:1                                               | `POST /repos/.../issues/{n}/comments` (body includes quote + permalink)                                                                                                          |
| `ResolveReviewThread`    | one `UpdateThreadResolved(true)`                                                     | 1:1                                               | GraphQL `resolveReviewThread`                                                                                                                                                    |
| `UnresolveReviewThread`  | one `UpdateThreadResolved(false)`                                                    | 1:1                                               | GraphQL `unresolveReviewThread`                                                                                                                                                  |
| `SetIssueThreadResolved` | one `UpdateThreadResolved` whose thread has `remoteIssueCommentId`                   | 1:1                                               | `GET /repos/.../issues/comments/{id}` → rewrite the hidden metadata with `resolved` → `PATCH /repos/.../issues/comments/{id}` (read-modify-write; the visible body is preserved) |
| `Commit`                 | all `CommitFileEdit`s in the cycle                                                   | many                                              | `createBlob`\* → `createTree` → `createCommit` → `updateRef` (Git Data API) **on `PullRequest.headRepo`** — the fork for a fork PR — executed as one atomic Step                 |

The #187 conflict check (`fetchBlobSha`) reads through the base repository, which can address every commit of the PR by sha; only the writes go to `headRepo`.

`UpdateThreadResolved` routes on the thread's remote identity: `remoteThreadId` → the GraphQL resolve/unresolve steps; `remoteIssueCommentId` → `SetIssueThreadResolved`. Issue-comment threads have no GraphQL thread, so their resolved state is stored on the root comment itself (ADR 0002 §5).

`UpdateThreadResolved` is offered only for threads whose `viewerCanResolve` is `true` ([ADR 0002 §3](0002-data-model.md)). The gate lives in the UI, not the Planner: the Executor still runs any Op it receives (an accept-triggered resolve, for instance), and a GitHub refusal lands the Thread in `draft + lastError` as usual.

In-diff vs out-of-diff routing for `CreateComment` is computed at planning time from the current diff (which the Executor fetches as part of `RemoteState`), not from any field on the Op. This was an explicit deviation from the legacy model where `inDiff` was frozen at draft creation.

**Posted coordinates are the current head's.** A review has a single `commit_id`, and Bark always posts against `RemoteState.pullRequest.headSha`, so the `line` / `start_line` it sends must be in that commit's coordinates. `Comment.anchor` is immutable (ADR 0002 §2) and may carry an older sha, so at planning time each `CreateComment` is re-anchored `anchor.sha → headSha` with the same line map ADR 0004 uses for display (`RemoteState.fileContents` therefore holds every anchored path at both shas). The in-diff routing and the posted copy (including the embedded metadata `anchor`) use the mapped range; `LocalState` keeps the original anchor. A `CreateComment` whose mapping is `outdated` becomes a `RejectComment` Step instead: it never reaches GitHub and fails locally, so the rest of the submission proceeds and the batch cannot 422 on stale lines (issue #265). A `CreateComment` whose re-anchoring is `shifted` — the line was located but the quoted text changed upstream — is also planned as `RejectComment`, with a message distinct from the `outdated` one. Posting it would attach the reviewer's words (and, for a suggestion, an applicable replacement) to text they never saw, and the posted copy's `quote` would no longer be the text at its range (ADR 0002 §3). The draft shows the same `shifted` badge before Submit, so the refusal matches what was flagged. `mapped` drafts, including those located by the region search, post at the mapped range with their quote unchanged (issue #313).

A `CreateComment` or `CreateReply` whose wire body (visible body + envelope) exceeds GitHub's 65,536-character limit is planned as `RejectComment` with a size error; the batch proceeds without it (issue #279).

### 6. Failure semantics

Each `ExecutionStep` returns per-item results:

- A 1:1 Step succeeds or fails as a whole; the single affected item lands in `synced`, or on failure in `draft + lastError` (new items) / `synced + lastError` with the field reverted (resolve toggles, [ADR 0001 §3](0001-pr-data-layer-architecture.md)).
- `PostReviewBatch` is atomic at GitHub — all-or-nothing — so the POST result is uniform across the bundled comments. Confirmation (§7) is per-comment: a comment the identity round-trip could not map lands in `draft + lastError` ("posted but not confirmed"), never stays `syncing`, and is adopted by `cid` on the next refresh (§7). The Transport distinguishes "POST failed" (`ok: false`, nothing on GitHub) from "POST ok, confirmation failed" (`ok: true` with a `confirmError` and no mappings): the latter must not look like a plain failure, or a retry would post the review twice.
- `Commit` is atomic from the Executor's perspective; intermediate failures (e.g. `updateRef` rejects with non-fast-forward) return every bundled `FileEdit` to `draft + lastError`.
- `RejectComment` always fails: the `Comment` (and its not-yet-created `Thread`) returns to `draft + lastError` with a "could not map to the current head" message. The user re-creates the comment on the current text.

The Reconciler is not responsible for retry. The user observes the error in the UI and re-triggers the action, which re-enters `draft → syncing`.

**`syncing` never survives its sync invocation.** Every entity that enters `syncing` ends the invocation in `synced` or `draft + lastError`. Two safety nets close the paths where a step result cannot deliver that (issue #266):

- **Hydrate** reverts any persisted `syncing` entity: to `synced + lastError` when it has a remote identity (the bootstrap refresh then restores GitHub's value), otherwise to `draft + lastError`. A fresh session has no step in flight, so nothing else would ever advance it, and the UI shows neither pending nor submitted items in that state.
- **Refresh adopts by `cid`.** `draft`/`syncing` items are normally protected from refresh, but a remote item whose id equals a local item that has no `remoteId` / `remoteThreadId` yet can only be that item's own post (the id was minted locally). The merge adopts the remote copy instead of discarding it, so an unconfirmed or interrupted post heals on the next refresh rather than being posted again.
- **End-of-invocation sweep.** When the reconcile loop stops (no Ops, or the cycle cap), any entity still `syncing` was never carried by a step — typically a reply whose parent did not sync this invocation. It is returned to `draft + lastError` naming the cause (parent not posted / parent no longer exists); Threads with a remote identity return to `synced + lastError` ([ADR 0001 §3](0001-pr-data-layer-architecture.md)).

### 7. Identity matching at the wire

For every `PostReviewBatch` / `PostReply` / `PostIssueComment`, the Executor:

1. Embeds `{ cid: Comment.id, threadId: Comment.threadId, anchor }` as base64-encoded hidden metadata in the comment body (ADR 0002 §5). The envelope's `anchor.quote` is capped at 1,000 characters; a capped envelope also carries `quoteDigest` and `quoteLength`. After the fetcher has loaded `FileContent(anchor.sha, path)`, it restores `quote` from `anchor.range` and keeps the excerpt only when the digest or length does not match.
2. After the API call returns, matches the freshly-created GitHub comments back to `LocalState` `Comment` entries by extracting the same metadata from the response bodies. `POST /pulls/{n}/reviews` returns only the review object, so for `PostReviewBatch` the Transport instead lists the PR's review threads via GraphQL right after the POST and matches by `cid`. GitHub's listing can lag behind the write, so while any posted `cid` is missing the Transport re-lists with a small bounded backoff (two retries, ~2 s total) before giving up.
3. Populates `Comment.remoteId` and flips state to `synced`. For a freshly-created thread it also fills the Thread's remote identity: `remoteThreadId` from the matched review thread (`PostReviewBatch`), or `remoteIssueCommentId` = the new comment's REST id when a top-level comment was posted as an issue comment (`PostIssueComment`). A `cid` still missing after the bound is reported as unmapped and handled per §6 (`draft + lastError`, adopted on the next refresh).

For Threads with no native body to embed in, identity is resolved at fetch time by joining GraphQL `reviewThreads` to the matched `Comment` set (any contained comment with a known `Comment.id` reveals the `Thread.id` ↔ `remoteThreadId` mapping).

For out-of-diff threads the join is by ownership instead: the earliest issue comment bearing a `threadId` is the thread's root, its REST id becomes `Thread.remoteIssueCommentId`, and `Thread.resolved` is read from that comment's `resolved` metadata. A later comment carrying the same `threadId` (a reply, or a forged fence) never contributes resolved state.

**Legacy metadata is read, never rewritten.** The envelope Bark writes is `bark:v2`. The extractor additionally accepts the `bark:v1` fence and its original `docreview:v1` alias read-only and maps them to the v2 shape (field renames, anchor normalisation, v1 `event` kept as `legacyResolveEvent` so legacy resolve-marker comments are recognised and dropped rather than rendered). Only a payload that is unparseable, fails validation, or carries an unknown version marker is discarded, and the comment is then treated as `meta: null` — a foreign comment Bark did not author.

This is not a migration and there is no migration path: v1 payloads live in comment bodies on github.com, which a client release cannot rewrite, so every release has to keep reading them. Local legacy data is a different matter: the legacy `chrome.storage.local` keys _are_ dropped rather than migrated ([ADR 0002](0002-data-model.md)). The Executor never repairs or re-emits a v1 payload; a comment posted from v2 onwards always carries a v2 fence. See `lib/pr/metadata.ts` (`extractMetadata`, `parseV1`).

## Consequences

### Positive

- **Reconciler stays pure and GitHub-ignorant.** Its inputs are state, its output is a flat list of intents; there is no API knowledge to leak.
- **Executor owns API truth.** Batching, atomicity, in-diff routing, metadata embedding — all the GitHub-shaped concerns are in one place and not entangled with state machinery.
- **`inDiff` is finally where it belongs.** It is recomputed at planning time, so a draft created against an old diff state is routed correctly when the diff has since shifted.
- **The catalog is small.** Four Ops, eight Steps. Most legacy "stages" of the author submit collapse into independent Steps; no orchestrator class is needed.

### Negative / costs

- **Some user actions feel "stronger" than the data model shows.** For example, an author submit that commits a file and resolves three threads is three independent Steps in three different categories, not one labelled operation. Per-item progress reporting may need UI affordance.
- **Reply ordering across `LocalState` ticks.** If a user submits a draft thread with a draft reply, the Reconciler emits only the parent's `CreateComment` in cycle N; the reply's `CreateReply` is emitted in cycle N+1 once the parent is synced. UX must tolerate this two-cycle settle.
- **No automatic retry.** A transient GitHub 5xx returns the entity to `draft` and requires the user to click again. This is intentional but is a behavior change from any future "retry once on 5xx" instinct.

### Deferred

- The exact retry / debouncing affordance in the UI for a failed `draft + lastError` item.
- The textual format of the out-of-diff `PostIssueComment` body (quote-prefixing, permalink shape) — currently inherited from the legacy implementation.
- Whether to ever introduce a `DeleteComment` or `UpdateCommentBody` Op. Not required by current Bark features.

## References

- [ADR 0001](0001-pr-data-layer-architecture.md) — pipeline, state machine, conflict policy, failure handling.
- [ADR 0002](0002-data-model.md) — entity shapes referenced by every Op/Step in this ADR.
