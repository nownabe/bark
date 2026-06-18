// Suggestion items render char-level: the whole line stays visible, and only the
// changed substring is emphasized (struck in old, highlighted in new).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { SuggestionDiff } from "../entrypoints/review/components/SuggestionDiff";

function textOf(el: Element | null): string {
  return el?.textContent ?? "";
}
function changedText(container: Element, selector: string): string {
  return [...container.querySelectorAll(`${selector} .sugg-chg`)]
    .map((n) => n.textContent)
    .join("");
}

describe("SuggestionDiff", () => {
  test("shows the full old and new text, not just the changed part", () => {
    const { container } = render(<SuggestionDiff before="the cat sat" after="the dog sat" />);
    expect(textOf(container.querySelector(".sugg-old"))).toBe("the cat sat");
    expect(textOf(container.querySelector(".sugg-new"))).toBe("the dog sat");
  });

  test("emphasizes only the changed substring in each line", () => {
    const { container } = render(<SuggestionDiff before="the cat sat" after="the dog sat" />);
    expect(changedText(container, ".sugg-old")).toBe("cat");
    expect(changedText(container, ".sugg-new")).toBe("dog");
  });

  test("a pure deletion shows a (delete) note on the new side", () => {
    const { container } = render(<SuggestionDiff before="remove me" after="" />);
    expect(textOf(container.querySelector(".sugg-old"))).toBe("remove me");
    expect(textOf(container.querySelector(".sugg-new"))).toBe("(delete)");
  });
});
