import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useUiPanels } from "../entrypoints/review/hooks/useUiPanels";

afterEach(() => {
  cleanup();
});

describe("useUiPanels — initial state", () => {
  test("every flag starts false", () => {
    const { result } = renderHook(() => useUiPanels());
    expect(result.current.showSubmitConfirm).toBe(false);
    expect(result.current.showDiscardConfirm).toBe(false);
    expect(result.current.showPrInfo).toBe(false);
    expect(result.current.showHelp).toBe(false);
    expect(result.current.showDebug).toBe(false);
  });
});

describe("useUiPanels — modal setters", () => {
  test("setShowSubmitConfirm flips the submit flag", () => {
    const { result } = renderHook(() => useUiPanels());
    act(() => result.current.setShowSubmitConfirm(true));
    expect(result.current.showSubmitConfirm).toBe(true);
    act(() => result.current.setShowSubmitConfirm(false));
    expect(result.current.showSubmitConfirm).toBe(false);
  });

  test("setShowDiscardConfirm flips the discard flag", () => {
    const { result } = renderHook(() => useUiPanels());
    act(() => result.current.setShowDiscardConfirm(true));
    expect(result.current.showDiscardConfirm).toBe(true);
  });
});

describe("useUiPanels — popovers / debug FAB toggle + close", () => {
  test("PR info, help and debug each have a toggle + close pair", () => {
    const { result } = renderHook(() => useUiPanels());

    act(() => result.current.togglePrInfo());
    expect(result.current.showPrInfo).toBe(true);
    act(() => result.current.togglePrInfo());
    expect(result.current.showPrInfo).toBe(false);
    act(() => result.current.togglePrInfo());
    act(() => result.current.closePrInfo());
    expect(result.current.showPrInfo).toBe(false);

    act(() => result.current.toggleHelp());
    expect(result.current.showHelp).toBe(true);
    act(() => result.current.closeHelp());
    expect(result.current.showHelp).toBe(false);

    act(() => result.current.toggleDebug());
    expect(result.current.showDebug).toBe(true);
    act(() => result.current.closeDebug());
    expect(result.current.showDebug).toBe(false);
  });
});

describe("useUiPanels — popover outside-click closes the popover", () => {
  test("mousedown OUTSIDE the PR-info popover (and its toggle) closes it", () => {
    const { result } = renderHook(() => useUiPanels());

    // Open PR info, then mount target elements + assign refs in DOM.
    act(() => result.current.togglePrInfo());
    expect(result.current.showPrInfo).toBe(true);

    const inside = document.createElement("div");
    document.body.appendChild(inside);
    (result.current.prInfoRef as { current: HTMLDivElement }).current = inside;

    const outside = document.createElement("div");
    document.body.appendChild(outside);

    // Clicking outside closes it.
    act(() => {
      outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(result.current.showPrInfo).toBe(false);

    document.body.removeChild(inside);
    document.body.removeChild(outside);
  });

  test("mousedown INSIDE the popover keeps it open", () => {
    const { result } = renderHook(() => useUiPanels());
    act(() => result.current.toggleHelp());
    const inside = document.createElement("div");
    document.body.appendChild(inside);
    (result.current.helpRef as { current: HTMLDivElement }).current = inside;

    act(() => {
      inside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(result.current.showHelp).toBe(true);

    document.body.removeChild(inside);
  });

  test("mousedown on the toggle BUTTON does NOT close (the button's own onClick toggles)", () => {
    const { result } = renderHook(() => useUiPanels());
    act(() => result.current.toggleHelp());
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    (result.current.helpBtnRef as { current: HTMLButtonElement }).current = btn;

    act(() => {
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(result.current.showHelp).toBe(true);

    document.body.removeChild(btn);
  });
});
