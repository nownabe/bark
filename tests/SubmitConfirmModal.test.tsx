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
import { buildPendingItems, type PendingSuggestion } from "../entrypoints/review/reviewItems";
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
  return buildPendingItems(drafts, pendingSuggestions);
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

  test("renders suggestions char-level (full text shown, change emphasized)", () => {
    const { container } = render(
      <SubmitConfirmModal items={pendingEntries()} onConfirm={() => {}} onCancel={() => {}} />,
    );
    // both old and new text are shown in full...
    expect(container.querySelector(".sugg-old")?.textContent).toBe("teh");
    expect(container.querySelector(".sugg-new")?.textContent).toBe("the");
    // ...with only the changed substring emphasized (char-level)
    expect(container.querySelector(".sugg-chg")).not.toBeNull();
  });

  test("groups items by file with a filename heading (submit spans all files)", () => {
    const { container } = render(
      <SubmitConfirmModal items={pendingEntries()} onConfirm={() => {}} onCancel={() => {}} />,
    );
    // no review/issue/suggestion badges inside the item list
    expect(container.querySelector(".modal__list .badge")).toBeNull();
    // the filename is shown as a group heading
    const heading = container.querySelector(".submit-group__file")?.textContent ?? "";
    expect(heading).toContain("docs/a.md");
  });

  test("shows the selected text being commented on, not just the line number", () => {
    const { container } = render(
      <SubmitConfirmModal items={pendingEntries()} onConfirm={() => {}} onCancel={() => {}} />,
    );
    const listText = container.querySelector(".modal__list")?.textContent ?? "";
    // the quoted source text the plain comment targets
    expect(listText).toContain("old text");
    // and the line label is still present
    expect(listText).toContain("L4");
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

  test("summarizes what will be posted and the target PR", () => {
    const { container } = render(
      <SubmitConfirmModal
        items={pendingEntries()}
        target={{ owner: "o", repo: "r", number: 7 }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const summary = container.querySelector(".submit-summary")?.textContent ?? "";
    expect(summary).toContain("o/r #7");
    // 1 in-diff comment + 1 in-diff suggestion → one review with both
    expect(summary).toContain("One review");
    expect(summary).toContain("1 comment and 1 suggestion");
  });

  test("renders a dialog role for accessibility", () => {
    const { container } = render(
      <SubmitConfirmModal items={pendingEntries()} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  test("submitLabel prop overrides the primary button text (author mode)", () => {
    const { container } = render(
      <SubmitConfirmModal
        items={pendingEntries()}
        submitLabel="Submit"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const submit = [...container.querySelectorAll("button")].find((b) =>
      /^Submit$/.test(b.textContent ?? ""),
    );
    expect(submit).not.toBeUndefined();
    // No leftover "Submit review" button
    const review = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Submit review",
    );
    expect(review).toBeUndefined();
  });

  test("author items render: acceptedSuggestion uses a SuggestionDiff with an Accept tag", () => {
    const items = [
      {
        kind: "acceptedSuggestion" as const,
        commentId: 42,
        path: "docs/a.md",
        quote: "old line",
        replacement: "new line",
        line: 5,
      },
    ];
    const { container } = render(
      <SubmitConfirmModal items={items} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.querySelector(".sugg-old")?.textContent).toBe("old line");
    expect(container.querySelector(".sugg-new")?.textContent).toBe("new line");
    // accept tag is rendered as a badge near the diff
    expect(container.querySelector(".tag--accept")?.textContent ?? "").toMatch(/accept/i);
  });

  test("summary line surfaces the single batched commit and acceptances", () => {
    const items = [
      { kind: "edit" as const, path: "docs/a.md" },
      { kind: "edit" as const, path: "docs/b.md" },
      {
        kind: "acceptedSuggestion" as const,
        commentId: 42,
        path: "docs/a.md",
        quote: "x",
        replacement: "y",
        line: 1,
      },
    ];
    const { container } = render(
      <SubmitConfirmModal
        items={items}
        target={{ owner: "o", repo: "r", number: 7 }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const summary = container.querySelector(".submit-summary")?.textContent ?? "";
    expect(summary).toMatch(/One commit/i);
    expect(summary).toContain("2 files");
    expect(summary).toMatch(/1 accepted suggestion/);
  });

  test("warns when the PR is merged or closed, and stays silent when it is open (#288)", () => {
    const render1 = (prStatus: "open" | "merged" | "closed") =>
      render(
        <SubmitConfirmModal
          items={pendingEntries()}
          prStatus={prStatus}
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      ).container;

    expect(render1("merged").querySelector(".notice--error")?.textContent ?? "").toMatch(/merged/i);
    expect(render1("closed").querySelector(".notice--error")?.textContent ?? "").toMatch(/closed/i);
    expect(render1("open").querySelector(".notice--error")).toBeNull();
  });
});
