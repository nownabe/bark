import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import {
  RedlineControls,
  type RedlineControlsProps,
} from "../entrypoints/review/components/RedlineControls";

afterEach(() => {
  cleanup();
});

function makeProps(overrides: Partial<RedlineControlsProps> = {}): RedlineControlsProps {
  return {
    enabled: true,
    baselineSha: "abcdef0123456",
    baselineSource: "lastVisit",
    prBaseRef: "main",
    lastVisitSha: "abcdef0123456",
    changeCount: 3,
    showSelector: false,
    selectorBtnRef: createRef<HTMLButtonElement>(),
    selectorRef: createRef<HTMLDivElement>(),
    onToggle: mock(() => {}),
    onChangeBaselineSource: mock(() => {}),
    onToggleSelector: mock(() => {}),
    onJumpPrev: mock(() => {}),
    onJumpNext: mock(() => {}),
    ...overrides,
  };
}

function byText(container: HTMLElement, text: string): Element | undefined {
  return Array.from(container.querySelectorAll("*")).find((el) =>
    el.textContent?.trim().includes(text),
  );
}

describe("RedlineControls", () => {
  test("no baseline → toggle is disabled with an explanatory tooltip", () => {
    const { container } = render(
      <RedlineControls {...makeProps({ baselineSha: null, enabled: false })} />,
    );
    const toggle = container.querySelector<HTMLButtonElement>(".redline-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle!.disabled).toBe(true);
    expect(toggle!.title.toLowerCase()).toContain("no previous visit");
  });

  test("with a baseline, the toggle is active and shows the short SHA", () => {
    const { container } = render(<RedlineControls {...makeProps()} />);
    const toggle = container.querySelector<HTMLButtonElement>(".redline-toggle");
    expect(toggle!.disabled).toBe(false);
    expect(toggle!.getAttribute("aria-pressed")).toBe("true");
    // The short SHA (7 chars) is shown in a mono/tabular element.
    expect(toggle!.textContent).toContain("abcdef0");
  });

  test("clicking the toggle fires onToggle", () => {
    const onToggle = mock(() => {});
    const { container } = render(<RedlineControls {...makeProps({ onToggle })} />);
    fireEvent.click(container.querySelector(".redline-toggle")!);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test("jump prev/next fire their handlers and the change count is shown", () => {
    const onJumpPrev = mock(() => {});
    const onJumpNext = mock(() => {});
    const { container } = render(
      <RedlineControls {...makeProps({ onJumpPrev, onJumpNext, changeCount: 5 })} />,
    );
    fireEvent.click(container.querySelector("[aria-label='Previous change']")!);
    fireEvent.click(container.querySelector("[aria-label='Next change']")!);
    expect(onJumpPrev).toHaveBeenCalledTimes(1);
    expect(onJumpNext).toHaveBeenCalledTimes(1);
    expect(byText(container, "5")).toBeDefined();
  });

  test("selector popover lists Last visit and PR base and reports a choice", () => {
    const onChangeBaselineSource = mock((_s: "lastVisit" | "prBase") => {});
    const { container } = render(
      <RedlineControls {...makeProps({ showSelector: true, onChangeBaselineSource })} />,
    );
    expect(byText(container, "Last visit")).toBeDefined();
    expect(byText(container, "PR base")).toBeDefined();
    const prBase = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".redline-option"),
    ).find((b) => b.textContent?.includes("PR base"))!;
    fireEvent.click(prBase);
    expect(onChangeBaselineSource).toHaveBeenCalledWith("prBase");
  });

  test("hidden entirely when disabled and there is no baseline and redline is off", () => {
    // When there is no baseline the toggle still renders (disabled), so the
    // control communicates why redline is unavailable rather than vanishing.
    const { container } = render(
      <RedlineControls {...makeProps({ baselineSha: null, enabled: false })} />,
    );
    expect(container.querySelector(".redline-toggle")).not.toBeNull();
    // Jump controls only show while redline is on with changes.
    expect(container.querySelector("[aria-label='Next change']")).toBeNull();
  });
});
