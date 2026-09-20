# ADR 0004: Re-anchoring algorithm and FileContent at past shas

- Date: 2026-06-25
- Status: Accepted
- Builds on: [ADR 0001](0001-pr-data-layer-architecture.md), [ADR 0002](0002-data-model.md), [ADR 0003](0003-operations-and-execution.md)
- Amends: [ADR 0002](0002-data-model.md) (generalises `RemoteState.FileContent` from `(path)` to `(sha, path)`)

## Context

`Comment.anchor` is immutable, per [ADR 0002 §2-3](0002-data-model.md): it pins a Comment to a specific `(sha, range, quote)` at creation. When the user views the PR at a later head sha, the editor must place the comment somewhere — re-anchored from the immutable anchor to the current source.

Legacy Bark used three fallback levels (sha match → diff-based line map → fuzzy `quote` search). The third level was a primary source of bugs: when `quote` appeared in more than one place in the new source, the comment silently attached to the wrong line. This ADR fixes the algorithm and eliminates the silent fallback.

The algorithm needs file content at past shas, not just the current head. That data is essential state for the application — without it, re-anchoring cannot be computed at all. This ADR places it in `RemoteState.FileContent` (generalised to `(sha, path)` identity), making it a first-class GitHub-mirror entity rather than an ad-hoc cache.

## Decision

### 1. `RemoteState.FileContent` is keyed by `(sha, path)`

Per [ADR 0002 §3](0002-data-model.md), `RemoteState` now holds:

```ts
type FileContent = {
  sha: string;
  path: string;
  source: string;
};
```

with `(sha, path)` as identity. Re-anchoring's current source is `FileContent` at `(headSha, comment.path)`, which the fetcher guarantees for every anchored path ([ADR 0005 §2](0005-refresh-policy.md)); older sha values are the other end of the line map. The editor's display source for the _viewed_ path is loaded by the UI layer through the same `fetchFileContent` (see ADR 0005 §2) and is not necessarily present in `RemoteState`.

`FileContent` is read-only and immutable per identity. The Reconciler does not diff it; the Executor fetches it on demand. It lives only in `RemoteState` (in-memory, refetched each session) — there is no `LocalState` counterpart because there is no user intent and no commit content ever changes after creation.

### 2. Prefetch on session bootstrap

After `LocalState` is hydrated and `RemoteState` is initialised, the Repository computes the set of unique `(anchor.sha, anchor.path)` pairs across all Comments, plus `(headSha, anchor.path)` for each distinct anchored path. For any pair not yet in `RemoteState.FileContent`, the Executor fetches the file content from GitHub (`GET /repos/.../contents/{path}?ref={sha}`).

This bounds the bootstrap cost to `O(distinct anchor.sha × paths)` per session. A persistent `FileContent` cache layer (across sessions) is an optional future optimisation; for now `RemoteState` is in-memory only, consistent with [ADR 0001 §2](0001-pr-data-layer-architecture.md).

### 3. Re-anchoring algorithm

For each Comment.anchor, compute the display position against the current `source`:

```mermaid
flowchart TD
    Start([Comment.anchor]) --> Q1{anchor.sha == headSha?}
    Q1 -->|yes| Current["status: current<br/>range: anchor.range"]
    Q1 -->|no| Q2{FileContent at<br/>(anchor.sha, anchor.path)<br/>available?}
    Q2 -->|no| Outdated["status: outdated"]
    Q2 -->|yes| LineMap[buildLineMap LCS<br/>oldSource → source]
    LineMap --> Q3{both anchor.sl and anchor.el<br/>map to a new line?}
    Q3 -->|no| Outdated
    Q3 -->|yes| Verify[extract text at mapped range]
    Verify --> Q4{extracted text<br/>== anchor.quote?}
    Q4 -->|yes| Mapped["status: mapped<br/>range: newRange"]
    Q4 -->|no| Shifted["status: shifted<br/>range: newRange"]
```

Notes:

- **No fuzzy `quote` search.** If the line-map cannot resolve both endpoints, the result is `outdated`. Never guess.
- **Column preservation.** `sc`/`ec` are carried through as offsets from the original line start. Column-level re-anchoring is deferred.
- **`shifted`** means the line was traceable through the diff but its content has been edited — the comment is probably still about the right area, but the user should look.
- **Line-map** is the standard LCS-based line-correspondence map. It is computed once per `(anchor.sha, path, headSha)` triple and reused across all comments on that file with the same `anchor.sha`.

### 4. Status taxonomy

| Status     | When                                     | UI presentation                                                            |
| ---------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| `current`  | `anchor.sha === headSha` — no work to do | normal inline                                                              |
| `mapped`   | line-map succeeded + quote verifies      | normal inline                                                              |
| `shifted`  | line-map succeeded, quote differs        | inline + "position shifted" badge                                          |
| `outdated` | FileContent missing or line-map failed   | grayed-out in sidebar, "view at original sha" link; not anchored in editor |

`current` and `mapped` are presentationally identical; the distinction is for debugging / telemetry only.

### 5. Edge cases

- **Partial span deletion** (start mapped, end's source line gone, or vice versa) → `outdated`. No clipping to a partial range — an explicit failure beats a silent half-truth.
- **Whole span deleted** → `outdated`.
- **Empty `quote`** → `outdated` (defensive; should not occur given creation invariants).
- **`anchor.sha` no longer in the PR's branch history** (e.g. force-push removed it) → `GET contents` returns 404 → `outdated`.

### 6. Computation location

Re-anchoring is an `AppState` derivation, per [ADR 0002 §1, §4](0002-data-model.md). For a given file:

```
displayPositions(file) = memoize(
  deps: [source, comments_for_file, fileContents],
  compute: () => {
    for each comment, reanchor(
      comment.anchor,
      source,                                        // = fileContents[(headSha, comment.path)] — guaranteed by §2
      headSha,
      fileContents[(comment.anchor.sha, comment.anchor.path)],
    )
  }
)
```

`AppState` reads `RemoteState.FileContent` as input but does not cache it independently.

## Consequences

### Positive

- **The largest legacy bug class is eliminated by design.** No silent fuzzy match means a comment is either at a verified line or visibly `outdated` — never in the wrong place pretending to be right.
- **`FileContent` is a single concept** covering both current display source and past-sha snapshots. The model has no parallel "current vs. snapshot" pair; `(sha, path)` keying unifies them.
- **Re-anchoring is well-typed input/output.** `(immutable anchor) + RemoteState.FileContent + current source → status + range`. Pure function in AppState.
- **No `LocalState` storage growth** from re-anchoring data. `RemoteState` is in-memory only.

### Negative

- **`outdated` comments are not pinned to a line in the editor.** They live in the sidebar with a deep link instead. This is a deliberate UX trade-off favouring correctness over completeness; legacy users may notice fewer comments inline.
- **Every session refetches past-sha file contents.** A PR with N distinct anchor.shas across M paths costs up to (N+1)×M `GET contents` calls on each open (the +1 is the head-sha copy of each anchored path). A persistent `FileContent` cache layer is an optional future optimisation.

### Deferred

- Column-level re-anchoring (currently `sc`/`ec` carry through unchanged).
- Cross-file content move tracking (renamed file → no FileContent match).
- Persistent `FileContent` cache for faster reopens.

## References

- [ADR 0001](0001-pr-data-layer-architecture.md) — pipeline, conflict policy.
- [ADR 0002](0002-data-model.md) — `Comment.anchor` immutability, `RemoteState.FileContent` shape, AppState derivation rules.
- [ADR 0003](0003-operations-and-execution.md) — Executor's fetch responsibility.
