import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { Topbar, type TopbarProps } from "../entrypoints/review/components/Topbar";
import type { ChangedFile, PullInfo } from "../lib/github";

afterEach(() => {
  cleanup();
});

function makeProps(overrides: Partial<TopbarProps> = {}): TopbarProps {
  return {
    prRef: { owner: "o", repo: "r", number: 1 },
    owner: "o",
    repo: "r",
    prNum: "1",
    pull: null,
    prStatus: null,
    headSha: null,
    files: [],
    selectedPath: null,
    viewMode: "preview",
    loading: false,
    pendingCount: 0,
    role: "reviewer",
    token: null,
    showPrInfo: false,
    showHelp: false,
    prInfoBtnRef: createRef<HTMLButtonElement>(),
    prInfoRef: createRef<HTMLDivElement>(),
    helpBtnRef: createRef<HTMLButtonElement>(),
    helpRef: createRef<HTMLDivElement>(),
    onSelectPath: () => {},
    onChangeViewMode: () => {},
    onAskSubmit: () => {},
    onAskDiscardAll: () => {},
    onTogglePrInfo: () => {},
    onToggleHelp: () => {},
    onClearToken: () => {},
    ...overrides,
  };
}

const samplePull = (overrides: Partial<PullInfo> = {}): PullInfo => ({
  title: "Add docs",
  author: "alice",
  body: "",
  headSha: "abcdef0123456",
  headRef: "feature",
  baseRef: "main",
  state: "open",
  draft: false,
  merged: false,
  ...overrides,
});

describe("Topbar — when no PR ref is provided", () => {
  test("shows the 'sample document' fallback hint and no PR head", () => {
    const { container } = render(<Topbar {...makeProps({ prRef: null })} />);
    expect(container.textContent).toContain("sample document");
    expect(container.querySelector(".topbar__pr-head")).toBeNull();
  });
});

describe("Topbar — PR head", () => {
  test("renders the GitHub PR link, status badge and short head SHA when pull is loaded", () => {
    const { container } = render(
      <Topbar
        {...makeProps({
          pull: samplePull(),
          prStatus: "open",
          headSha: "abcdef0123456",
        })}
      />,
    );
    const link = container.querySelector("a.topbar__pr-title") as HTMLAnchorElement | null;
    expect(link?.getAttribute("href")).toBe("https://github.com/o/r/pull/1");
    expect(link?.textContent).toContain("Add docs");
    expect(container.querySelector(".badge--pr-open")?.textContent).toBe("Open");
    expect(container.textContent).toContain("@abcdef0");
  });

  test("falls back to 'owner/repo #num' when pull has not loaded yet", () => {
    const { container } = render(<Topbar {...makeProps({ pull: null })} />);
    const link = container.querySelector("a.topbar__pr-title");
    expect(link?.textContent).toContain("o/r #1");
  });
});

describe("Topbar — file picker", () => {
  test("renders each ChangedFile path and routes selection through onSelectPath", () => {
    const onSelectPath = mock((_path: string) => {});
    const files: ChangedFile[] = [
      { path: "a.md", status: "modified", patch: "" },
      { path: "b.md", status: "added", patch: "" },
    ];
    const { container } = render(
      <Topbar {...makeProps({ files, selectedPath: "a.md", onSelectPath })} />,
    );
    const select = container.querySelector("select.input") as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["a.md", "b.md"]);
    fireEvent.change(select, { target: { value: "b.md" } });
    expect(onSelectPath).toHaveBeenCalledWith("b.md");
  });

  test("file picker is hidden when there are no files", () => {
    const { container } = render(<Topbar {...makeProps({ files: [] })} />);
    expect(container.querySelector("select.input")).toBeNull();
  });
});

describe("Topbar — view mode toggle", () => {
  test("aria-pressed reflects viewMode and clicking the other button calls onChangeViewMode", () => {
    const onChangeViewMode = mock((_mode: "raw" | "preview") => {});
    const { container } = render(
      <Topbar {...makeProps({ viewMode: "preview", onChangeViewMode })} />,
    );
    const pressed = container.querySelector(
      ".seg button[aria-pressed='true']",
    ) as HTMLButtonElement;
    expect(pressed.textContent).toBe("Preview");
    const other = Array.from(container.querySelectorAll(".seg button")).find(
      (b) => b.getAttribute("aria-pressed") === "false",
    ) as HTMLButtonElement;
    fireEvent.click(other);
    expect(onChangeViewMode).toHaveBeenCalledWith("raw");
  });
});

describe("Topbar — Submit / Discard buttons", () => {
  function submitButton(container: ParentNode): HTMLButtonElement {
    const buttons = Array.from(container.querySelectorAll("button.btn--primary"));
    return buttons.find((b) => b.textContent?.includes("Submit")) as HTMLButtonElement;
  }
  function discardButton(container: ParentNode): HTMLButtonElement {
    return container.querySelector(
      "button[aria-label='Discard all pending items']",
    ) as HTMLButtonElement;
  }

  test("are disabled when there are no pending items", () => {
    const { container } = render(<Topbar {...makeProps({ pull: samplePull() })} />);
    expect(submitButton(container).disabled).toBe(true);
    expect(discardButton(container).disabled).toBe(true);
  });

  test("fire their handlers when there are pending items", () => {
    const onAskSubmit = mock(() => {});
    const onAskDiscardAll = mock(() => {});
    const { container } = render(
      <Topbar
        {...makeProps({
          pull: samplePull(),
          pendingCount: 2,
          onAskSubmit,
          onAskDiscardAll,
        })}
      />,
    );
    fireEvent.click(submitButton(container));
    fireEvent.click(discardButton(container));
    expect(onAskSubmit).toHaveBeenCalledTimes(1);
    expect(onAskDiscardAll).toHaveBeenCalledTimes(1);
  });

  test("Submit label reflects role + pendingCount", () => {
    const reviewer = render(<Topbar {...makeProps({ pull: samplePull(), pendingCount: 3 })} />);
    expect(submitButton(reviewer.container).textContent).toBe("Submit review (3)");
    reviewer.unmount();
    const author = render(
      <Topbar {...makeProps({ pull: samplePull(), pendingCount: 3, role: "author" })} />,
    );
    expect(submitButton(author.container).textContent).toBe("Submit (3)");
  });
});

describe("Topbar — info / help popovers", () => {
  test("info button calls onTogglePrInfo, and the popover renders pull.body when showPrInfo is true", () => {
    const onTogglePrInfo = mock(() => {});
    const pull = samplePull({ body: "This is the description." });
    const { container, rerender } = render(<Topbar {...makeProps({ pull, onTogglePrInfo })} />);
    expect(container.querySelector(".popover.popover--pr")).toBeNull();
    const infoBtn = container.querySelector(".topbar__info-btn") as HTMLButtonElement;
    fireEvent.click(infoBtn);
    expect(onTogglePrInfo).toHaveBeenCalledTimes(1);
    rerender(<Topbar {...makeProps({ pull, showPrInfo: true, onTogglePrInfo })} />);
    expect(container.querySelector(".popover.popover--pr")?.textContent).toContain(
      "This is the description.",
    );
  });

  test("help popover's 'Delete token' button is shown only when a token is present", () => {
    const onClearToken = mock(() => {});
    const noToken = render(<Topbar {...makeProps({ showHelp: true, token: null })} />);
    expect(noToken.container.querySelector(".popover button.btn--danger")).toBeNull();
    noToken.unmount();
    const withToken = render(
      <Topbar {...makeProps({ showHelp: true, token: "tkn", onClearToken })} />,
    );
    const delBtn = withToken.container.querySelector(
      ".popover button.btn--danger",
    ) as HTMLButtonElement;
    fireEvent.click(delBtn);
    expect(onClearToken).toHaveBeenCalledTimes(1);
  });
});
