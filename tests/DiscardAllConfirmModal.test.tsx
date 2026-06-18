// Discard-all confirmation modal.
//
// Discarding every pending review item is destructive and unrecoverable, so the
// "Discard all" action must not fire immediately; it opens a confirmation modal
// stating how many items will be dropped, with explicit Discard / Cancel actions.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { DiscardAllConfirmModal } from "../entrypoints/review/components/DiscardAllConfirmModal";

describe("DiscardAllConfirmModal", () => {
  test("renders a dialog role for accessibility", () => {
    const { container } = render(
      <DiscardAllConfirmModal count={3} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  test("states how many pending items will be discarded", () => {
    const { container } = render(
      <DiscardAllConfirmModal count={3} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.textContent ?? "").toContain("3");
  });

  test("warns the action cannot be undone", () => {
    const { container } = render(
      <DiscardAllConfirmModal count={2} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect((container.textContent ?? "").toLowerCase()).toContain("can't be undone");
  });

  test("Discard triggers onConfirm, not before", () => {
    let confirmed = 0;
    const { container } = render(
      <DiscardAllConfirmModal count={2} onConfirm={() => confirmed++} onCancel={() => {}} />,
    );
    expect(confirmed).toBe(0);
    const discard = [...container.querySelectorAll("button")].find((b) =>
      /discard/i.test(b.textContent ?? ""),
    )!;
    fireEvent.click(discard);
    expect(confirmed).toBe(1);
  });

  test("Cancel triggers onCancel", () => {
    let cancelled = 0;
    const { container } = render(
      <DiscardAllConfirmModal count={2} onConfirm={() => {}} onCancel={() => cancelled++} />,
    );
    const cancel = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel",
    )!;
    fireEvent.click(cancel);
    expect(cancelled).toBe(1);
  });
});
