// The right-side review list.
//
// Hosts the per-facet filter (Pending / Sent / Resolved), the unified
// review-entry list (live suggestions + threads), and — when a comment
// composer is open — the SelectionComposer inserted at the position
// matching the active anchor.
//
// All the per-thread / per-suggestion rendering still lives in App.tsx
// (it depends on enough App state that lifting it would be its own
// refactor). The parent supplies it as a pair of render functions, so
// this component stays pure presentation.

import type { ReactNode, RefObject } from "react";
import type { SourceAnchor } from "../../../lib/anchor";
import {
  composerInsertIndex,
  type PendingSuggestion,
  type ReviewEntry,
  type ReviewFacet,
  type ReviewThread,
  sortPos,
} from "../reviewItems";
import { SelectionComposer } from "./SelectionComposer";

export type ReviewSidebarProps = {
  sidebarRef: RefObject<HTMLElement>;
  reviewFilter: Set<ReviewFacet>;
  counts: { pending: number; submitted: number; resolved: number };
  onToggleFacet: (f: ReviewFacet) => void;
  visibleEntries: ReviewEntry[];
  anchor: SourceAnchor | null;
  commentBody: string;
  onChangeComposer: (v: string) => void;
  onAddDraft: () => void;
  onDiscardComposer: () => void;
  renderLiveSuggestion: (s: PendingSuggestion) => ReactNode;
  renderThread: (t: ReviewThread) => ReactNode;
};

const FACETS = ["pending", "submitted", "resolved"] as const;
const FACET_LABEL: Record<ReviewFacet, string> = {
  pending: "Pending",
  submitted: "Sent",
  resolved: "Resolved",
};

export function ReviewSidebar({
  sidebarRef,
  reviewFilter,
  counts,
  onToggleFacet,
  visibleEntries,
  anchor,
  commentBody,
  onChangeComposer,
  onAddDraft,
  onDiscardComposer,
  renderLiveSuggestion,
  renderThread,
}: ReviewSidebarProps) {
  return (
    <aside className="sidebar" ref={sidebarRef}>
      {/* one list: the selection composer, pending items and submitted
          threads all live here — no separate comment / suggestion / review
          blocks. */}
      <section className="panel panel--bare">
        <div className="panel__head">
          <h2 className="panel__title">Review</h2>
          <div className="seg seg--sm">
            {FACETS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={reviewFilter.has(f)}
                onClick={() => onToggleFacet(f)}
              >
                {FACET_LABEL[f]} ({counts[f]})
              </button>
            ))}
          </div>
        </div>
        {visibleEntries.length === 0 && !anchor ? (
          <p className="empty">No items.</p>
        ) : (
          buildEntryList({
            visibleEntries,
            anchor,
            renderLiveSuggestion,
            renderThread,
            commentBody,
            onChangeComposer,
            onAddDraft,
            onDiscardComposer,
          })
        )}
      </section>
    </aside>
  );
}

function buildEntryList(opts: {
  visibleEntries: ReviewEntry[];
  anchor: SourceAnchor | null;
  renderLiveSuggestion: (s: PendingSuggestion) => ReactNode;
  renderThread: (t: ReviewThread) => ReactNode;
  commentBody: string;
  onChangeComposer: (v: string) => void;
  onAddDraft: () => void;
  onDiscardComposer: () => void;
}): ReactNode[] {
  const {
    visibleEntries,
    anchor,
    renderLiveSuggestion,
    renderThread,
    commentBody,
    onChangeComposer,
    onAddDraft,
    onDiscardComposer,
  } = opts;
  const items: ReactNode[] = visibleEntries.map((e) =>
    e.kind === "liveSuggestion" ? renderLiveSuggestion(e.suggestion) : renderThread(e.thread),
  );
  if (anchor) {
    const idx = composerInsertIndex(visibleEntries, sortPos(anchor.startLine, anchor.startCol));
    items.splice(
      idx,
      0,
      <SelectionComposer
        key="__composer"
        anchor={anchor}
        value={commentBody}
        onChange={onChangeComposer}
        onAdd={onAddDraft}
        onDiscard={onDiscardComposer}
      />,
    );
  }
  return items;
}
