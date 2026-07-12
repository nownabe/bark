# Bark — Design Principles

Reference for anyone (human or agent) styling Bark's UI. It captures the intent
behind the design system so changes stay cohesive. The **source of truth for
the actual values is the `:root` token block in
`entrypoints/review/styles.css`** — this document explains the _why_ and the
_how to use_, not a second copy of the numbers.

## 1. North star

Bark is a Google-Docs-like Markdown review surface for GitHub PRs. The UI should
feel **calm, readable, and trustworthy** — it sits next to GitHub, so it adopts
a clean, light, GitHub-adjacent tone, but executed with more care: deliberate
typography, consistent spacing, soft depth, and restrained motion.

Guiding values, in priority order:

1. **Readability first.** The document being reviewed is the hero. Chrome
   (top bar, sidebar, controls) must never compete with the content.
2. **Consistency over novelty.** Every surface draws from the same tokens. A new
   component should look like it was always there.
3. **Refined, not loud.** Depth, motion, and color are used sparingly and
   intentionally. When in doubt, do less.
4. **Quiet until needed.** Color and emphasis are reserved for meaning
   (state, action, selection), not decoration.

## 2. Foundations

### Color & theme

Light theme only (for now). The palette is a neutral ramp plus **one brand color
and one interactive accent** — do not introduce a third hue without reason.

- **Brand green** (`--brand`, `--brand-strong`, `--brand-tint`) — Bark's
  identity (the mascot). Drives **primary actions** (`.btn--primary`), the gate
  accent bar, and "positive/anchored" states. Green = Bark and "go".
- **Interactive accent / blue** (`--accent`, `--accent-strong`, `--accent-tint`,
  `--ring`) — **links, focus rings, selection, and emphasis** (e.g. an
  emphasized thread, the active segment chip). Blue = "interactive".
- **Neutrals** — surfaces (`--bg`, `--bg-canvas`, `--bg-subtle`, `--bg-inset`),
  text (`--fg`, `--fg-soft`, `--muted`, `--faint`), hairlines (`--border`,
  `--border-subtle`).
- **Semantic** — `--amber*` (pending / attention), `--red*` (errors / danger /
  outdated). Each has a `-tint` for soft backgrounds.

Rules:

- **Don't mix brand and accent for the same purpose.** Primary buttons are
  green; links/focus are blue. Keep that split so each color stays meaningful.
- Use the `*-tint` variables for soft fills (badges, emphasized rows), never
  full-saturation backgrounds behind text.
- `--bg` is the elevated surface (cards, top bar, popovers); `--bg-canvas` is the
  page behind them. Surfaces sit _on_ the canvas.

### Typography

- **No remote fonts.** Bark is offline-friendly and privacy-conscious (the
  project restricts network egress), so we never pull from a font CDN. We rely
  on an elevated system stack (`--font-sans`) and a quality monospace
  (`--font-mono`). If a bundled custom face is ever wanted, ship the files in the
  extension — never a runtime `<link>` to Google Fonts.
- Body is 14px / line-height 1.6, antialiased. The document editor (`.cm-editor`)
  is a touch larger (15px) for reading comfort.
- **Hierarchy comes from weight, size, and color — not many type families.**
  Headings: 700 weight, slightly tight tracking (`letter-spacing: -0.02em`).
  Labels/eyebrows: small, uppercase, positive tracking, `--faint` color
  (see `.panel__title`).
- Use `--font-mono` for code, suggestions (old/new), the device code, and debug
  output. Use `font-variant-numeric: tabular-nums` for SHAs and metrics so digits
  align.

### Spacing & layout

- Keep spacing on a small, consistent rhythm (multiples of ~4px). Reuse the
  paddings already established (cards ~16px, gates ~32px, controls ~6–13px).
- The review screen is a two-column grid (`.layout`): a content column
  (`minmax(0, 1fr)`) beside a 360px sidebar, max-width 1200px, collapsing to one
  column under 900px.
- The sidebar is sticky; the top bar is sticky and translucent (blurred).

### Radii

Three steps: `--radius-sm` (controls — buttons, inputs, segments),
`--radius` (cards, gates, modal, popovers), `--radius-pill` (badges, pills,
FABs). Don't invent in-between values.

### Elevation (shadows)

Four soft, layered steps: `--shadow-sm` → `--shadow` → `--shadow-md` →
`--shadow-lg`. Elevation tracks importance: resting cards use `--shadow`/`-sm`;
popovers/modals use `-md`/`-lg`. Shadows are soft and low-contrast — no hard or
heavy drop shadows.

### Motion

- Tokens: `--ease` (a gentle ease-out) and `--dur` (~160ms).
- **High-impact, low-frequency.** Prefer one tasteful entrance (gates, modal,
  popovers via `gate-in` / `pop-in` / `fade-in`) and subtle hover/active
  feedback (button press, FAB lift) over scattered micro-animations.
- **Always honor `prefers-reduced-motion`** — the global reduce block must keep
  covering new animations.

### Focus & accessibility

- Every interactive element gets a **consistent keyboard focus ring** (`--ring`,
  applied via `:focus-visible`). Don't remove it; don't make a bespoke one.
- Maintain sufficient contrast (text on tinted backgrounds uses the matching
  saturated color, e.g. `--amber` text on `--amber-tint`).
- Color is never the _only_ signal — pair it with text/badges/icons.

## 3. Component conventions

- **Buttons** (`.btn`, `.btn--primary`, `.btn--sm`, `.btn--danger`): 500 weight,
  `--radius-sm`, token-driven transitions, a slight press (`translateY`).
  Primary = brand green. Danger = red outline that fills with `--red-tint` on
  hover. One primary action per context.
- **Segmented control** (`.seg`, `.seg--dark`, `.seg--sm`): a subtle track with a
  raised active chip. Default active = accent (blue); `--dark` active = `--fg`
  (used for view mode). Distinct active colors keep different switches legible.
- **Fields** (`.field`, `select.input`): hairline border, accent border + ring on
  focus. `.field--mono` for code-ish input.
- **Panels** (`.panel`, `.panel__title`, `.panel__head`): elevated card with an
  uppercase eyebrow title.
- **Threads / comments** (`.thread`, `.thread--clickable`, `.thread--emphasized`,
  `.comment*`): emphasized state uses the accent tint + ring; pending items use a
  left accent border.
- **Badges** (`.badge--*`): pill, soft tint background + matching saturated text,
  one per state.
- **Gates** (`.gate`): the full-screen auth / device-code / install screens.
  Branded header (logo + name), gradient accent bar at the top, gentle entrance.
  Reuse this pattern for any "blocking, you-must-act" screen rather than dropping
  the user into the main UI with an error notice.
- **Modal / popover** (`.modal*`, `.popover*`, `.debug-popover`): elevated
  surface, soft large shadow, blurred scrim for the modal, entrance animation.
- **Snackbar (global error surface):** transient toast pinned to the bottom of
  the viewport. It is the **default channel for any user-relevant error** —
  failed refresh, failed sync, fetch / auth errors. Components may additionally
  reflect errors inline where context helps (a retry affordance near a failed
  draft, an `outdated` badge on a comment), but the Snackbar is always used;
  errors are never surfaced silently. Severity uses the semantic palette
  (`--red*` for errors, `--amber*` for warnings); auto-dismiss after a few
  seconds with a close affordance.
- **Redline overlay** (`.redline*`, R10): the Topbar "Redline" toggle chip
  (`.redline-toggle`) reads like a `.seg` chip and turns **accent** (blue =
  interactive) when active, carrying the baseline's short SHA in
  `--font-mono` / `tabular-nums`; it dims when disabled (no baseline). The
  baseline selector reuses the `.popover` pattern (`.popover--redline`,
  `.redline-option`). Over the document, the char-level baseline→head diff uses
  its **own** classes so it never collides with suggest mode: insertions
  (`.dr-redline-ins`) echo suggest mode's green tint + underline ("new"),
  deletions (`.dr-redline-del`) strike through in `--red`. Same green/red split
  as suggest mode, kept on separate classes because the two overlays are
  mutually exclusive (redline is read-only preview; suggest is the edit diff).
- **Floating controls** (`.debug-fab` bottom-left, `.role-fab` bottom-right):
  pill/circle, translucent, lift on hover. Dev-only controls (e.g. the
  role switch behind `BARK_DEV_ROLE_SWITCH`) live here, out of the main chrome.

## 4. Working rules

- **Edit tokens, not values.** Change a `--token` in `:root` to shift the whole
  app; reach for a literal value only for a genuinely one-off case.
- **Preserve class names.** The markup in `entrypoints/review/App.tsx` depends on
  them; refine by changing CSS values, not by renaming/restructuring selectors.
  Markup changes should be minimal and purposeful.
- **Keep the reduced-motion block in sync** when adding animation.
- **No new accent hues, fonts, radii, or shadow steps** without a real need —
  extend the existing scales first.
- **English** for everything committed (this file, comments, commits, PRs).
- Run the checks before committing: `bun run test`, `check:lint`,
  `check:format`, `typecheck`, `build` (build runs outside the sandbox).

## 5. Hard constraints

- **Chrome MV3 extension**, rendered in the review SPA page
  (`entrypoints/review/`). No remote runtime dependencies for styling (fonts,
  CSS) — bundle everything.
- The content-script "Open in Bark" button on github.com is styled inline in
  `entrypoints/content.ts` (it lives on GitHub's page, not the SPA); keep it
  on-brand (the mascot) but self-contained.
