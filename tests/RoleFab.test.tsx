import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { RoleFab } from "../entrypoints/review/components/RoleFab";
import type { Role } from "../entrypoints/review/reviewItems";

afterEach(() => {
  cleanup();
});

describe("RoleFab", () => {
  test("renders the 'dev' label and two role buttons", () => {
    const { container } = render(<RoleFab role="reviewer" onChangeRole={() => {}} />);
    expect(container.querySelector(".role-fab__label")?.textContent).toBe("dev");
    const buttons = Array.from(container.querySelectorAll(".seg button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["author", "reviewer"]);
  });

  test("aria-pressed reflects the active role", () => {
    const reviewer = render(<RoleFab role="reviewer" onChangeRole={() => {}} />);
    const reviewerBtn = Array.from(reviewer.container.querySelectorAll("button")).find(
      (b) => b.textContent === "reviewer",
    ) as HTMLButtonElement;
    expect(reviewerBtn.getAttribute("aria-pressed")).toBe("true");
    reviewer.unmount();
    const author = render(<RoleFab role="author" onChangeRole={() => {}} />);
    const authorBtn = Array.from(author.container.querySelectorAll("button")).find(
      (b) => b.textContent === "author",
    ) as HTMLButtonElement;
    expect(authorBtn.getAttribute("aria-pressed")).toBe("true");
  });

  test("clicking the other role forwards the new role to onChangeRole", () => {
    const onChangeRole = mock((_r: Role) => {});
    const { container } = render(<RoleFab role="reviewer" onChangeRole={onChangeRole} />);
    const authorBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "author",
    ) as HTMLButtonElement;
    fireEvent.click(authorBtn);
    expect(onChangeRole).toHaveBeenCalledWith("author");
  });
});
