// Submit-review confirmation modal — task 3.
//
// Clicking "Submit review" must not submit immediately; it opens a confirmation
// modal listing the pending items that are about to be submitted, with explicit
// Submit / Cancel actions.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { SubmitConfirmModal } from "../entrypoints/review/components/SubmitConfirmModal";
import { buildReviewEntries, type PendingSuggestion } from "../entrypoints/review/reviewItems";
import type { PendingDraft } from "../lib/drafts";

const drafts: PendingDraft[] = [
  {
    cid: "d1",
    path: "docs/a.md",
    inDiff: true,
    range: { sl: 4, sc: 1, el: 4, ec: 5 },
    quote: "old text",
    sha: "sha",
    thread: "d1",
    body: "please fix this typo",
    kind: "comment",
  },
];
const pendingSuggestions: PendingSuggestion[] = [
  {
    cid: "live:7",
    path: "docs/a.md",
    inDiff: true,
    range: { sl: 7, sc: 1, el: 7, ec: 1 },
    quote: "teh",
    replacement: "the",
    body: "(suggested edit)",
  },
];

function pendingEntries() {
  return buildReviewEntries({ drafts, threads: [], pendingSuggestions, currentPath: "docs/a.md" });
}

describe("SubmitConfirmModal", () => {
  test("lists every pending item that will be submitted", () => {
    const { container } = render(
      <SubmitConfirmModal items={pendingEntries()} onConfirm={() => {}} onCancel={() => {}} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("please fix this typo");
    // suggestion replacement is visible so the reviewer knows what they send
    expect(text).toContain("the");
    // count of items to submit (1 draft + 1 live suggestion)
    expect(text).toContain("2");
  });

  test("does not show the filename or review/issue/suggestion tags inside items", () => {
    const { container } = render(
      <SubmitConfirmModal items={pendingEntries()} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.querySelector(".modal__list .badge")).toBeNull();
    const listText = container.querySelector(".modal__list")?.textContent ?? "";
    expect(listText).not.toContain("docs/a.md");
  });

  test("Submit triggers onConfirm, not before", () => {
    let confirmed = 0;
    const { container } = render(
      <SubmitConfirmModal
        items={pendingEntries()}
        onConfirm={() => confirmed++}
        onCancel={() => {}}
      />,
    );
    expect(confirmed).toBe(0);
    const submit = [...container.querySelectorAll("button")].find((b) =>
      /submit/i.test(b.textContent ?? ""),
    )!;
    fireEvent.click(submit);
    expect(confirmed).toBe(1);
  });

  test("Cancel triggers onCancel", () => {
    let cancelled = 0;
    const { container } = render(
      <SubmitConfirmModal
        items={pendingEntries()}
        onConfirm={() => {}}
        onCancel={() => cancelled++}
      />,
    );
    const cancel = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel",
    )!;
    fireEvent.click(cancel);
    expect(cancelled).toBe(1);
  });

  test("renders a dialog role for accessibility", () => {
    const { container } = render(
      <SubmitConfirmModal items={pendingEntries()} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
