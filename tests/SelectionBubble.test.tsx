// Selection bubble — the icon-only round button shown just above a text
// selection in the editor. Clicking it opens the comment composer (wired in
// App.tsx). It renders nothing when there is no selection position.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { SelectionBubble } from "../entrypoints/review/components/SelectionBubble";

describe("SelectionBubble", () => {
  test("renders a button at the given position", () => {
    const { container } = render(
      <SelectionBubble pos={{ top: 120, left: 48 }} onClick={() => {}} />,
    );
    const btn = container.querySelector<HTMLButtonElement>("button.selection-bubble");
    expect(btn).not.toBeNull();
    expect(btn!.style.top).toBe("120px");
    expect(btn!.style.left).toBe("48px");
  });

  test("renders nothing when pos is null", () => {
    const { container } = render(<SelectionBubble pos={null} onClick={() => {}} />);
    expect(container.querySelector("button")).toBeNull();
  });

  test("fires onClick when pressed", () => {
    let clicked = 0;
    const { container } = render(
      <SelectionBubble pos={{ top: 0, left: 0 }} onClick={() => clicked++} />,
    );
    fireEvent.click(container.querySelector("button.selection-bubble")!);
    expect(clicked).toBe(1);
  });
});
