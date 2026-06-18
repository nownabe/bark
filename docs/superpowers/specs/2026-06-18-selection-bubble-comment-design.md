# Selection bubble button → gated comment composer

## Problem

Today, selecting any text in the review editor _immediately_ renders
`SelectionComposer` at the top of the sidebar list (`App.tsx`, driven by the
`anchor` state). There is no intermediate step: a stray selection opens a
comment box. This is noisy and unlike the Google-Docs-style flow Bark is after.

## Goal

When the user selects text in the editor, show a small icon-only round "bubble"
button just above the selection. The comment composer must **not** open until
that button is clicked. Clicking the bubble opens `SelectionComposer` (in the
sidebar, at the position that matches the selection's line) and focuses the
textarea.

## Non-goals

- No floating/popover composer near the selection — the composer stays in the
  sidebar (as today), only gated behind the bubble and re-positioned.
- No change to drafting/submit logic, threads, or persistence.

## Design

### State model (`entrypoints/review/App.tsx`)

Split the single `anchor` source into "pending selection" and "open composer":

- **New `selection: SourceAnchor | null`** — set by the editor `onUpdate`
  handler on a non-empty text selection (this is what `handleSelectionUpdate`
  feeds today via `setAnchor`). Drives the bubble button only.
- **New `bubblePos: { top: number; left: number } | null`** — viewport coords
  for the button, computed from `view.coordsAtPos(selection.startOffset)`,
  placed just above the selection start. Null when there is no selection.
- **Existing `anchor: SourceAnchor | null`** — now set **only** when the bubble
  is clicked. `openComposer()` copies `selection → anchor` and clears
  `selection`/`bubblePos`. All downstream code (`SelectionComposer`,
  `addDraft`, `discardComposer`) is unchanged.

Behavioral consequence (accepted): once open, the composer stays open until
**Add** or **Discard** — it no longer auto-closes when the editor selection
collapses. This is symmetric with "doesn't open until clicked" and matches the
Google-Docs feel.

### Selection handling

`handleSelectionUpdate` (in `cmAnchor.ts`) currently maps a `ViewUpdate` to a
`SourceAnchor | null` and calls `setAnchor`. It will instead drive the new
`selection` state plus `bubblePos`:

- On a non-empty selection: set `selection` to the anchor and compute
  `bubblePos` from `view.coordsAtPos(anchor.startOffset)`.
- On an empty/collapsed selection: clear `selection` and `bubblePos` (leaving
  any open `anchor` composer untouched).

`bubblePos` is also recomputed on editor scroll/resize while a `selection` is
active (lightweight listener on the editor scroller), so the fixed-position
button does not float stale. If the selection start scrolls out of the editor
viewport, the bubble is hidden.

A small pure helper computes the button anchor point from the CodeMirror coords
(e.g. `bubbleAnchorPoint(coords, { gap, height })`) so it is unit-testable.

### Bubble button component

New `entrypoints/review/components/SelectionBubble.tsx`:

- Props: `pos: { top; left } | null`, `onClick: () => void`.
- Renders `null` when `pos` is null.
- Icon-only round button (inline speech-bubble SVG), `position: fixed` at
  `pos`, with `aria-label`/`title` "Comment".

New `.selection-bubble` CSS class in `styles.css`, built from existing tokens:
`--radius-pill`, `--shadow-md`, brand color, and the `pop-in` animation. No new
raw color/shadow literals.

### Composer at the "appropriate position"

Instead of rendering `SelectionComposer` before the whole list, insert it into
`visibleEntries` at the index matching the selection's document position:

- New pure helper in `reviewItems.ts`:
  `composerInsertIndex(entries: ReviewEntry[], pos: number): number` — returns
  the index of the first entry whose `sortPos` is greater than `pos`
  (i.e. where the composer should be spliced), or `entries.length` if none.
- The composer's `pos` is `posOf(anchor.range)` (line dominates, column breaks
  ties — same key the entries already sort by).
- `App.tsx` renders entries with the composer spliced at that index when
  `anchor` is set.

### Focus

The textarea keeps `autoFocus`; since the composer mounts fresh on bubble
click, it focuses automatically. Back it with an explicit `ref.focus()` to be
certain.

## Testing (TDD)

Pure / component tests (run under `bun run test`, happy-dom):

- `composerInsertIndex` — empty list, before all, after all, between two
  entries, and equal-position tie-break.
- `bubbleAnchorPoint` — places the point the configured gap above the coords.
- `SelectionBubble` — renders at `pos`, renders nothing when `pos` is null,
  fires `onClick`.

CodeMirror selection wiring in `App.tsx` (selection → bubble → composer) is
verified by `bun run build` plus manual check, because happy-dom cannot lay out
CodeMirror for `coordsAtPos`.

## Files touched

- `entrypoints/review/App.tsx` — state split, `openComposer`, bubble render,
  composer insertion, scroll/resize reposition.
- `entrypoints/review/cmAnchor.ts` — selection handler drives `selection` +
  `bubblePos`; add `bubbleAnchorPoint` helper.
- `entrypoints/review/components/SelectionBubble.tsx` — new component.
- `entrypoints/review/reviewItems.ts` — add `composerInsertIndex`.
- `entrypoints/review/styles.css` — `.selection-bubble` class.
- `tests/` — new tests mirroring the above.
