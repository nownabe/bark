# ADR 0003: ReconcileOperation and ExecutionStep — the two-layer change pipeline

- Date: 2026-06-25
- Status: Accepted
- Builds on: [ADR 0001](0001-pr-data-layer-architecture.md), [ADR 0002](0002-data-model.md)

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
- **Comment in `syncing` with `parentLocalId` whose parent is not yet `synced`** → no Op emitted this cycle; the parent's `CreateComment` will sync first, and the next cycle re-evaluates.
- **`Thread.resolved` differs from `RemoteState`, state is `syncing`** → `UpdateThreadResolved` (carrying the desired boolean).
- **`FileEdit` in `syncing`** → `CommitFileEdit`.

The Reconciler does not look at multiple entities to decide what to emit. Whether two `CreateComment`s become one review batch is the Executor's call.

### 3. Executor — planning and ordering

The Executor receives a `ReconcileOperation[]` per Reconciler cycle and plans `ExecutionStep[]`. It is responsible for:

- **Batching.** All `CreateComment` Ops targeting in-diff anchors collapse into one `PostReviewBatch`. Out-of-diff `CreateComment`s become one `PostIssueComment` each. `CreateReply`s map 1:1 to `PostReply` (no batch API exists).
- **Ordering.** No global ordering constraint exists today: the Bark resolve marker is gone (ADR 0002 §7), so `ResolveReviewThread` no longer depends on a prior `Commit`. Steps can run concurrently within one cycle.
- **Atomicity.** `PostReviewBatch` is atomic by GitHub design. `Commit` is multi-call but the Executor treats it as one atomic Step: a failure at any sub-call fails the whole Step.
- **Identity round-trip.** The Executor embeds `{ cid, threadId, anchor }` as base64 hidden metadata in any comment body it posts, and extracts the same on fetch.

### 4. `ReconcileOperation` catalog

| Op                     | Inputs (from `LocalState`)                                       | Trigger                                   |
| ---------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| `CreateComment`        | `Comment` (state=syncing, remoteId absent, parentLocalId absent) | top-level draft Comment submitted         |
| `CreateReply`          | `Comment` + parent `Comment` (parent must be synced)             | reply draft submitted with synced parent  |
| `UpdateThreadResolved` | `threadId`, `desiredResolved: boolean`                           | `Thread.resolved` toggled and now syncing |
| `CommitFileEdit`       | `FileEdit` (path, baseSha, editedSource)                         | `FileEdit` flipped to syncing             |

That's the complete set. No `AcceptSuggestionOp`, no `AuthorSubmitOp`, no `DeleteCommentOp`, no `UpdateCommentBodyOp` — features that don't exist as separate state changes don't need their own Op.

### 5. `ExecutionStep` catalog

| Step                    | Inputs                             | Bundles                                           | GitHub API                                                                                               |
| ----------------------- | ---------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `PostReviewBatch`       | in-diff `CreateComment[]`          | many `CreateComment`s sharing the same submission | `POST /repos/.../pulls/{n}/reviews` (one call, atomic)                                                   |
| `RejectComment`         | one unmappable `CreateComment`     | 1:1                                               | none — fails locally (see below)                                                                         |
| `PostReply`             | one `CreateReply`                  | 1:1                                               | `POST /repos/.../pulls/{n}/comments` with `in_reply_to`                                                  |
| `PostIssueComment`      | one out-of-diff `CreateComment`    | 1:1                                               | `POST /repos/.../issues/{n}/comments` (body includes quote + permalink)                                  |
| `ResolveReviewThread`   | one `UpdateThreadResolved(true)`   | 1:1                                               | GraphQL `resolveReviewThread`                                                                            |
| `UnresolveReviewThread` | one `UpdateThreadResolved(false)`  | 1:1                                               | GraphQL `unresolveReviewThread`                                                                          |
| `Commit`                | all `CommitFileEdit`s in the cycle | many                                              | `createBlob`\* → `createTree` → `createCommit` → `updateRef` (Git Data API), executed as one atomic Step |

In-diff vs out-of-diff routing for `CreateComment` is computed at planning time from the current diff (which the Executor fetches as part of `RemoteState`), not from any field on the Op. This was an explicit deviation from the legacy model where `inDiff` was frozen at draft creation.

**Posted coordinates are the current head's.** A review has a single `commit_id`, and Bark always posts against `RemoteState.pullRequest.headSha`, so the `line` / `start_line` it sends must be in that commit's coordinates. `Comment.anchor` is immutable (ADR 0002 §2) and may carry an older sha, so at planning time each `CreateComment` is re-anchored `anchor.sha → headSha` with the same line map ADR 0004 uses for display (`RemoteState.fileContents` therefore holds every anchored path at both shas). The in-diff routing and the posted copy (including the embedded metadata `anchor`) use the mapped range; `LocalState` keeps the original anchor. A `CreateComment` whose mapping is `outdated` becomes a `RejectComment` Step instead: it never reaches GitHub and fails locally, so the rest of the submission proceeds and the batch cannot 422 on stale lines (issue #265).

### 6. Failure semantics

Each `ExecutionStep` returns per-item results:

- A 1:1 Step succeeds or fails as a whole; the single affected item lands in `synced` or `draft + lastError`.
- `PostReviewBatch` is atomic at GitHub — all-or-nothing — so its result is uniform across the bundled comments. (A protocol-level partial success is not possible; a network failure mid-call is treated as full failure pending re-fetch confirmation.)
- `Commit` is atomic from the Executor's perspective; intermediate failures (e.g. `updateRef` rejects with non-fast-forward) return every bundled `FileEdit` to `draft + lastError`.
- `RejectComment` always fails: the `Comment` (and its not-yet-created `Thread`) returns to `draft + lastError` with a "could not map to the current head" message. The user re-creates the comment on the current text.

The Reconciler is not responsible for retry. The user observes the error in the UI and re-triggers the action, which re-enters `draft → syncing`.

### 7. Identity matching at the wire

For every `PostReviewBatch` / `PostReply` / `PostIssueComment`, the Executor:

1. Embeds `{ cid: Comment.id, threadId: Comment.threadId, anchor }` as base64-encoded hidden metadata in the comment body (ADR 0002 §5).
2. After the API call returns, matches the freshly-created GitHub comments back to `LocalState` `Comment` entries by extracting the same metadata from the response bodies.
3. Populates `Comment.remoteId` (and, for a freshly-created thread, the matched `Thread.remoteThreadId`) and flips state to `synced`.

For Threads with no native body to embed in, identity is resolved at fetch time by joining GraphQL `reviewThreads` to the matched `Comment` set (any contained comment with a known `Comment.id` reveals the `Thread.id` ↔ `remoteThreadId` mapping).

**Legacy metadata is discarded.** Bark is pre-release, so no production data needs migration. Any hidden metadata in a comment body that does not match the current envelope (wrong version marker, wrong schema, unparseable) is silently dropped during extraction and the comment is treated as `meta: null` — i.e. as a foreign comment Bark did not author. The Executor never attempts to translate, repair, or re-emit legacy payloads.

## Consequences

### Positive

- **Reconciler stays pure and GitHub-ignorant.** Its inputs are state, its output is a flat list of intents; there is no API knowledge to leak.
- **Executor owns API truth.** Batching, atomicity, in-diff routing, metadata embedding — all the GitHub-shaped concerns are in one place and not entangled with state machinery.
- **`inDiff` is finally where it belongs.** It is recomputed at planning time, so a draft created against an old diff state is routed correctly when the diff has since shifted.
- **The catalog is small.** Four Ops, six Steps. Most legacy "stages" of the author submit collapse into independent Steps; no orchestrator class is needed.

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
