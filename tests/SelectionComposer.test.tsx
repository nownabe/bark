// Selection composer — task 6.
//
// When the reviewer selects text, the composer must show the *content* of the
// selected text (a quote), not just the line label (e.g. "L17").
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
        routing={{ kind: "review" }}
        value=""
        onChange={() => {}}
        onAdd={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(container.textContent).toContain("the quick brown fox");
  });

  test("preserves multi-line selection content", () => {
    const { container } = render(
      <SelectionComposer
        anchor={anchor({ quotedText: "line one\nline two", endLine: 18 })}
        routing={{ kind: "issue" }}
        value=""
        onChange={() => {}}
        onAdd={() => {}}
        onCancel={() => {}}
      />,
    );
    const quote = container.querySelector(".composer__quote");
    expect(quote).not.toBeNull();
    expect(quote!.textContent).toBe("line one\nline two");
  });

  test("Add and Cancel buttons fire their callbacks", () => {
    let added = 0;
    let cancelled = 0;
    const { container } = render(
      <SelectionComposer
        anchor={anchor()}
        routing={{ kind: "review" }}
        value="hi"
        onChange={() => {}}
        onAdd={() => added++}
        onCancel={() => cancelled++}
      />,
    );
    const buttons = [...container.querySelectorAll("button")];
    const add = buttons.find((b) => b.textContent === "Add")!;
    const cancel = buttons.find((b) => b.textContent === "Cancel")!;
    fireEvent.click(add);
    fireEvent.click(cancel);
    expect(added).toBe(1);
    expect(cancelled).toBe(1);
  });
});
