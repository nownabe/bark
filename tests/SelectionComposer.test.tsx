// Selection composer — now an inline item in the unified list (no separate
// block), showing the selected text. Add confirms it as a pending item;
// Discard throws the input away. No review/issue/suggestion tags.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { SelectionComposer } from "../entrypoints/review/components/SelectionComposer";
import type { SourceAnchor } from "../lib/anchor";

function anchor(over: Partial<SourceAnchor> = {}): SourceAnchor {
  return {
    startOffset: 0,
    endOffset: 10,
    startLine: 17,
    startCol: 1,
    endLine: 17,
    endCol: 11,
    quotedText: "selected snippet",
    ...over,
  };
}

describe("SelectionComposer", () => {
  test("shows the quoted selected text", () => {
    const { container } = render(
      <SelectionComposer
        anchor={anchor({ quotedText: "the quick brown fox" })}
        value=""
        onChange={() => {}}
        onAdd={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(container.textContent).toContain("the quick brown fox");
  });

  test("preserves multi-line selection content", () => {
    const { container } = render(
      <SelectionComposer
        anchor={anchor({ quotedText: "line one\nline two", endLine: 18 })}
        value=""
        onChange={() => {}}
        onAdd={() => {}}
        onDiscard={() => {}}
      />,
    );
    const quote = container.querySelector(".composer__quote");
    expect(quote).not.toBeNull();
    expect(quote!.textContent).toBe("line one\nline two");
  });

  test("does not render review / issue / suggestion tags", () => {
    const { container } = render(
      <SelectionComposer
        anchor={anchor()}
        value=""
        onChange={() => {}}
        onAdd={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(container.querySelector(".badge")).toBeNull();
  });

  test("Add and Discard buttons fire their callbacks", () => {
    let added = 0;
    let discarded = 0;
    const { container } = render(
      <SelectionComposer
        anchor={anchor()}
        value="hi"
        onChange={() => {}}
        onAdd={() => added++}
        onDiscard={() => discarded++}
      />,
    );
    const buttons = [...container.querySelectorAll("button")];
    const add = buttons.find((b) => b.textContent === "Add")!;
    const discard = buttons.find((b) => b.textContent === "Discard")!;
    fireEvent.click(add);
    fireEvent.click(discard);
    expect(added).toBe(1);
    expect(discarded).toBe(1);
  });
});
