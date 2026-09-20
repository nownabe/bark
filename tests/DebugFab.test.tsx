import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DebugFab, type DebugFabProps } from "../entrypoints/review/components/DebugFab";
import type { SourceAnchor } from "../lib/anchor";

afterEach(() => {
  cleanup();
});

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

function makeProps(overrides: Partial<DebugFabProps> = {}): DebugFabProps {
  return {
    show: false,
    onToggle: () => {},
    onClose: () => {},
    role: "reviewer",
    viewMode: "preview",
    headSha: null,
    edited: false,
    draftsCount: 0,
    anchor: null,
    ...overrides,
  };
}

describe("DebugFab — button", () => {
  test("the floating button is always rendered and forwards clicks to onToggle", () => {
    const onToggle = mock(() => {});
    const { container } = render(<DebugFab {...makeProps({ onToggle })} />);
    const btn = container.querySelector(".debug-fab") as HTMLButtonElement;
    expect(btn.textContent).toBe("🐛");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("DebugFab — popover (hidden)", () => {
  test("the popover is absent when show=false", () => {
    const { container } = render(<DebugFab {...makeProps()} />);
    expect(container.querySelector(".debug-popover")).toBeNull();
  });
});

describe("DebugFab — manual refresh (ADR 0005 §5)", () => {
  test("a 'Refresh' button calls onRefresh", () => {
    const onRefresh = mock(() => {});
    const { container } = render(<DebugFab {...makeProps({ show: true, onRefresh })} />);
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Refresh",
    ) as HTMLButtonElement;
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test("without onRefresh (not wired yet), no Refresh button renders", () => {
    const { container } = render(<DebugFab {...makeProps({ show: true })} />);
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Refresh",
    );
    expect(btn).toBeUndefined();
  });
});

describe("DebugFab — popover (visible)", () => {
  test("shows role / viewMode / head SHA / edited yes-no / draft count", () => {
    const { container } = render(
      <DebugFab
        {...makeProps({
          show: true,
          role: "author",
          viewMode: "raw",
          headSha: "abcdef0123456",
          edited: true,
          draftsCount: 3,
        })}
      />,
    );
    const text = container.querySelector(".debug-popover")?.textContent ?? "";
    expect(text).toContain("author / raw");
    expect(text).toContain("abcdef0");
    expect(text).toContain("yes");
    expect(text).toContain("3");
  });

  test("'Close' button calls onClose", () => {
    const onClose = mock(() => {});
    const { container } = render(<DebugFab {...makeProps({ show: true, onClose })} />);
    const closeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Close",
    ) as HTMLButtonElement;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("with no anchor, prompts to select text", () => {
    const { container } = render(<DebugFab {...makeProps({ show: true, anchor: null })} />);
    expect(container.querySelector(".debug-popover .empty")?.textContent).toContain("Select text");
  });

  test("with an anchor, shows offset / range / quote", () => {
    const { container } = render(
      <DebugFab
        {...makeProps({
          show: true,
          anchor: makeAnchor({
            startOffset: 10,
            endOffset: 20,
            startLine: 2,
            startCol: 1,
            endLine: 2,
            endCol: 5,
            quotedText: "foo bar",
          }),
        })}
      />,
    );
    const text = container.querySelector(".debug-popover")?.textContent ?? "";
    expect(text).toContain("10–20");
    expect(text).toContain("L2:1–L2:5");
    expect(container.querySelector(".debug-popover pre")?.textContent).toBe("foo bar");
  });
});
