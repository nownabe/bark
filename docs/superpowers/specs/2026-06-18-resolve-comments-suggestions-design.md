# Resolve comments & suggestions — design

## Goal

Let reviewers and authors **resolve** Bark comment/suggestion threads, the way a
Google-Docs reviewer marks a conversation done. Suggestions need no explicit
resolve: once **accepted** they count as resolved. Provide a way to view resolved
items separately from active ones.

## Source of truth

Resolved state is stored as **hidden metadata on GitHub** (the existing
`bark:v1` embedded-metadata mechanism), so the state is reconstructable from the
REST comment lists Bark already fetches, uniformly for in-diff (review) and
out-of-diff (issue) threads. For in-diff threads we **additionally** call
GitHub's native `resolveReviewThread` so GitHub-UI users see the thread collapsed
— a mirror of the metadata SoT, not the SoT itself.

## Mechanism: resolution-event comments

Resolving a thread posts a new comment that carries hidden metadata marking a
resolution **event** for that thread. This append-only approach always works
across comment authors (unlike editing someone else's root comment, which the
GitHub API forbids).

- **Metadata** (`lib/metadata.ts`): add `event?: "resolve" | "unresolve"` to
  `CommentMetadata`. A comment whose metadata has `event` set is a _resolution
  marker_: it is consumed during reconstruction and **never rendered as a thread
  message**. It still carries the normal anchor fields (`thread`, `path`,
  `range`, `quote`, `sha`, fresh `cid`) so it groups under the right thread.
- **Posting**:
  - in-diff thread (root is a `source: "review"` comment): REST
    `POST /pulls/{n}/comments` with `in_reply_to: <root review comment id>`.
  - out-of-diff thread (issue-comment thread): REST issue comment.
  - The visible body is a short human-readable line (e.g. `Resolved via Bark.` /
    `Reopened via Bark.`) followed by the hidden marker.
- **Native mirror (in-diff only)**: after posting the reply, look up the thread's
  GraphQL node id and call `resolveReviewThread` / `unresolveReviewThread`.
- **Reconstruction**: per thread, the latest resolution event by GitHub comment
  id wins. `resolved` is true when that latest event is `resolve`. Out-of-diff
  threads get no native mirror (GitHub does not support resolving issue-comment
  threads) — the metadata event is the only signal there.

## Accepted suggestions = resolved

The existing accept flow (`acceptSuggestion` → local `dismissed` decision
`"accepted"`) is unchanged. No extra GitHub resolution event is written for
accepts. A thread whose root is a suggestion with decision `"accepted"` is
treated as `resolved` in the views. (Accept stages a local source change applied
on Commit; relying on the accept decision avoids recording "resolved" before the
change lands.)

## Timing

Resolve/Reopen are **immediate**: the action posts the event comment (and runs
the native mirror for in-diff), then reloads comments. This matches the existing
immediate accept flow and the inherently-immediate nature of native resolve.
Only threads that have a Bark thread id **and** at least one submitted comment
can be resolved (a resolve must reply to / reference an existing GitHub comment);
pending-only threads show no resolve control.

## GitHub client additions (`lib/github.ts`)

- `graphql(query, variables)` — POST to `https://api.github.com/graphql`.
- `listReviewThreads(ref)` — returns `{ id: string; isResolved: boolean;
commentIds: number[] }[]` (node id + each comment's `databaseId`).
- `resolveReviewThread(nodeId)` / `unresolveReviewThread(nodeId)` — GraphQL
  mutations.
- `replyToReviewComment(ref, inReplyTo, body)` — REST reply within a review
  thread.
- `findThreadNodeId(threads, commentId)` — **pure** helper mapping a root review
  comment id to its thread node id (unit-tested without network).

## Review-items model (`entrypoints/review/reviewItems.ts`)

- `ReviewThread` gains `resolved: boolean`.
- `buildThreads(comments, drafts, currentPath, opts?)`:
  - Partition comments into regular vs resolution events (`meta?.event` set).
  - Resolution events are excluded from `messages` and from root selection, but
    feed a per-thread latest-event map.
  - `resolved` = (latest resolution event is `resolve`) **or** (root is an
    accepted suggestion). Accepted ids are supplied via `opts.accepted`
    (a predicate or set keyed by GitHub comment id).
- Filter changes from a single `ReviewFilter` to a **multi-select facet set**:
  `type ReviewFacet = "pending" | "submitted" | "resolved"`. The `"all"` value is
  removed.
  - `filterReviewEntries(entries, facets: Set<ReviewFacet>)`:
    - live suggestion → shown iff `pending ∈ facets` (never resolved/submitted).
    - thread → shown iff any of:
      - `resolved ∈ facets` and `thread.resolved`
      - `pending ∈ facets` and `thread.hasPending` and `!thread.resolved`
      - `submitted ∈ facets` and `thread.hasSubmitted` and `!thread.resolved`
  - `reviewEntryCounts(entries)` returns `{ pending, submitted, resolved }`.

## UI (`entrypoints/review/App.tsx`, `styles.css`)

- Filter control: the `seg` single-select becomes **multi-select toggle chips**
  for Pending / Sent / Resolved. Default selection = `{pending, submitted}`
  (resolved hidden by default). Toggling a chip adds/removes its facet.
- Thread rendering: add a **Resolve** button on eligible threads (Bark thread id
  - has submitted comment) when not resolved, and a **Reopen** button when
    resolved. Resolved threads may show a `resolved` badge.
- Handlers: `resolveThread(thread)` / `reopenThread(thread)` build the resolution
  metadata, post the event comment via the right route, run the native mirror for
  in-diff, and reload.
- The "ensure emphasized item is visible" code paths (which currently force
  `"all"`) select all three facets so the emphasized thread always shows.
- Check `design.md` before the chip restyle and keep tokens/classes consistent.

## Testing (TDD)

- `tests/metadata.test.ts` — `embed`/`extract` round-trip preserves `event`.
- `tests/reviewItems.test.ts`:
  - `resolved` derived from resolution events (latest wins; `unresolve` after
    `resolve` re-opens).
  - resolution-event comments excluded from `messages`.
  - accepted suggestion → `resolved`.
  - `filterReviewEntries` multi-facet behavior (incl. resolved hidden from
    pending/submitted facets).
  - `reviewEntryCounts` new shape.
- `tests/github.test.ts` — `findThreadNodeId` mapping (match, no-match).

## Out of scope

- Resolving non-Bark threads (comments without a Bark thread id).
- Reading GitHub-native `isResolved` as a SoT (metadata is the SoT; native is a
  one-way mirror).
- Bulk resolve / resolve-all.
