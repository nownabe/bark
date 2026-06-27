import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import {
  ReviewSidebar,
  type ReviewSidebarProps,
} from "../entrypoints/review/components/ReviewSidebar";
import type { SourceAnchor } from "../lib/anchor";
import type {
  PendingSuggestion,
  ReviewEntry,
  ReviewFacet,
  ReviewThread,
} from "../entrypoints/review/reviewItems";

afterEach(() => {
  cleanup();
});

function makeThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "t-1",
    messages: [],
    rootComment: null,
    rootDraft: null,
    path: "f.md",
    pos: 0,
    quote: undefined,
    hasPending: false,
    hasSubmitted: true,
    resolved: false,
    ...overrides,
  };
}

function makeSuggestion(overrides: Partial<PendingSuggestion> = {}): PendingSuggestion {
  return {
    cid: "live:1:1",
    path: "f.md",
    inDiff: true,
    range: { sl: 1, sc: 1, el: 1, ec: 5 },
    quote: "hello",
    replacement: "world",
    body: "",
    ...overrides,
  };
}

function makeAnchor(overrides: Partial<SourceAnchor> = {}): SourceAnchor {
  return {
    startOffset: 0,
    endOffset: 5,
    startLine: 1,
    startCol: 1,
    endLine: 1,
    endCol: 6,
    quotedText: "hello",
    ...overrides,
  };
}

function makeProps(overrides: Partial<ReviewSidebarProps> = {}): ReviewSidebarProps {
  return {
    sidebarRef: createRef<HTMLElement>(),
    reviewFilter: new Set<ReviewFacet>(["pending", "submitted"]),
    counts: { pending: 0, submitted: 0, resolved: 0 },
    onToggleFacet: () => {},
    visibleEntries: [],
    anchor: null,
    commentBody: "",
    onChangeComposer: () => {},
    onAddDraft: () => {},
    onDiscardComposer: () => {},
    renderLiveSuggestion: (s) => (
      <div key={`sugg-${s.cid}`} data-testid={`sugg-${s.cid}`}>
        sugg:{s.replacement}
      </div>
    ),
    renderThread: (t) => (
      <div key={`thr-${t.id}`} data-testid={`thr-${t.id}`}>
        thread:{t.id}
      </div>
    ),
    ...overrides,
  };
}

describe("ReviewSidebar — empty state", () => {
  test("shows 'No items.' when there are no entries and no active composer", () => {
    const { container } = render(<ReviewSidebar {...makeProps()} />);
    expect(container.textContent).toContain("No items.");
    expect(container.querySelector(".panel__title")?.textContent).toBe("Review");
  });

  test("the empty-list message is hidden while a SelectionComposer is open", () => {
    const { container } = render(<ReviewSidebar {...makeProps({ anchor: makeAnchor() })} />);
    expect(container.textContent).not.toContain("No items.");
  });
});

describe("ReviewSidebar — filter facets", () => {
  test("each facet button shows its label, its count and an aria-pressed flag from reviewFilter", () => {
    const { container } = render(
      <ReviewSidebar
        {...makeProps({
          reviewFilter: new Set<ReviewFacet>(["pending"]),
          counts: { pending: 2, submitted: 5, resolved: 1 },
        })}
      />,
    );
    const buttons = Array.from(container.querySelectorAll(".seg button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Pending (2)", "Sent (5)", "Resolved (1)"]);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");
    expect(buttons[2]?.getAttribute("aria-pressed")).toBe("false");
  });

  test("clicking a facet forwards the facet name to onToggleFacet", () => {
    const onToggleFacet = mock((_f: ReviewFacet) => {});
    const { container } = render(<ReviewSidebar {...makeProps({ onToggleFacet })} />);
    const sentBtn = Array.from(container.querySelectorAll(".seg button")).find((b) =>
      b.textContent?.startsWith("Sent"),
    ) as HTMLButtonElement;
    fireEvent.click(sentBtn);
    expect(onToggleFacet).toHaveBeenCalledWith("submitted");
  });
});

describe("ReviewSidebar — entries", () => {
  test("delegates rendering of each entry to renderThread / renderLiveSuggestion in list order", () => {
    const t = makeThread({ id: "t-a", pos: 0 });
    const s = makeSuggestion({ cid: "live:2:2", replacement: "X" });
    const visibleEntries: ReviewEntry[] = [
      { kind: "thread", sortPath: "f.md", sortPos: 0, thread: t },
      { kind: "liveSuggestion", sortPath: "f.md", sortPos: 1, suggestion: s },
    ];
    const renderThread = mock((tt: ReviewThread) => (
      <div key={tt.id} data-testid={`thr-${tt.id}`}>
        T-{tt.id}
      </div>
    ));
    const renderLiveSuggestion = mock((ss: PendingSuggestion) => (
      <div key={ss.cid} data-testid={`sugg-${ss.cid}`}>
        S-{ss.replacement}
      </div>
    ));
    const { container, getByTestId } = render(
      <ReviewSidebar {...makeProps({ visibleEntries, renderThread, renderLiveSuggestion })} />,
    );
    expect(getByTestId("thr-t-a")).not.toBeNull();
    expect(getByTestId("sugg-live:2:2")).not.toBeNull();
    expect(renderThread).toHaveBeenCalledWith(t);
    expect(renderLiveSuggestion).toHaveBeenCalledWith(s);
    // Order: thread first, then suggestion.
    const list = container.querySelectorAll("[data-testid]");
    expect(Array.from(list).map((n) => n.getAttribute("data-testid"))).toEqual([
      "thr-t-a",
      "sugg-live:2:2",
    ]);
  });
});

describe("ReviewSidebar — SelectionComposer placement", () => {
  test("with no anchor, no composer is rendered", () => {
    const { container } = render(<ReviewSidebar {...makeProps()} />);
    expect(container.querySelector("textarea")).toBeNull();
  });

  test("with an anchor + entries, the composer is inserted at the position dictated by composerInsertIndex", () => {
    // Two threads at line 1 and line 5; an anchor at line 3 should land between them.
    // sortPos(line, col) = line * 100000 + col (see reviewItems.ts).
    const t1 = makeThread({ id: "t-1", pos: 100001 });
    const t5 = makeThread({ id: "t-5", pos: 500001 });
    const visibleEntries: ReviewEntry[] = [
      { kind: "thread", sortPath: "f.md", sortPos: t1.pos, thread: t1 },
      { kind: "thread", sortPath: "f.md", sortPos: t5.pos, thread: t5 },
    ];
    const { container } = render(
      <ReviewSidebar
        {...makeProps({
          visibleEntries,
          anchor: makeAnchor({ startLine: 3, startCol: 1, endLine: 3, endCol: 5 }),
        })}
      />,
    );
    // 1 composer textarea + 2 thread placeholders.
    expect(container.querySelectorAll("textarea").length).toBe(1);
    // Direct children of `.panel` minus the head row are the list items.
    const panel = container.querySelector(".panel") as HTMLElement;
    const directChildren = Array.from(panel.children).filter(
      (n) => !n.classList.contains("panel__head"),
    );
    const orderedKeys = directChildren.map((n) =>
      n.classList.contains("review-item--composer")
        ? "composer"
        : (n.getAttribute("data-testid") ?? ""),
    );
    expect(orderedKeys).toEqual(["thr-t-1", "composer", "thr-t-5"]);
  });
});
