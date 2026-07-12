import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SidebarViewSwitch } from "../entrypoints/review/components/SidebarViewSwitch";

afterEach(() => {
  cleanup();
});

describe("SidebarViewSwitch", () => {
  test("renders a Review / History segmented control reflecting the active view", () => {
    const { container } = render(<SidebarViewSwitch view="review" onChange={() => {}} />);
    const buttons = Array.from(container.querySelectorAll(".seg button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Review", "History"]);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");
  });

  test("clicking History forwards 'history' to onChange", () => {
    const onChange = mock((_v: "review" | "history") => {});
    const { container } = render(<SidebarViewSwitch view="review" onChange={onChange} />);
    const historyBtn = Array.from(container.querySelectorAll(".seg button")).find(
      (b) => b.textContent === "History",
    ) as HTMLButtonElement;
    fireEvent.click(historyBtn);
    expect(onChange).toHaveBeenCalledWith("history");
  });

  test("reflects the history view as active", () => {
    const { container } = render(<SidebarViewSwitch view="history" onChange={() => {}} />);
    const buttons = Array.from(container.querySelectorAll(".seg button"));
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("true");
  });
});
