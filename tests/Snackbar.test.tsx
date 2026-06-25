import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { SnackbarProvider, useSnackbar } from "../entrypoints/review/components/Snackbar";

afterEach(() => {
  cleanup();
});

function wrap(durationMs?: number) {
  return ({ children }: { children: ReactNode }) => (
    <SnackbarProvider durationMs={durationMs}>{children}</SnackbarProvider>
  );
}

describe("Snackbar — useSnackbar", () => {
  test("throws when no provider is present", () => {
    expect(() => renderHook(() => useSnackbar())).toThrow(/SnackbarProvider/);
  });

  test("show() renders a snackbar with the given message", () => {
    const { result } = renderHook(() => useSnackbar(), {
      wrapper: wrap(60_000),
    });
    act(() => {
      result.current.show("Something failed");
    });
    const node = document.querySelector(".snackbar");
    expect(node?.textContent).toContain("Something failed");
  });

  test("error severity is the default and applies snackbar--error", () => {
    const { result } = renderHook(() => useSnackbar(), { wrapper: wrap(60_000) });
    act(() => {
      result.current.show("oops");
    });
    expect(document.querySelector(".snackbar--error")).not.toBeNull();
  });

  test("warning severity applies snackbar--warning", () => {
    const { result } = renderHook(() => useSnackbar(), { wrapper: wrap(60_000) });
    act(() => {
      result.current.show("careful", "warning");
    });
    expect(document.querySelector(".snackbar--warning")).not.toBeNull();
  });

  test("clicking the close button removes the snackbar", () => {
    const { result } = renderHook(() => useSnackbar(), { wrapper: wrap(60_000) });
    act(() => {
      result.current.show("dismiss me");
    });
    const closeBtn = document.querySelector(".snackbar__close");
    expect(closeBtn).not.toBeNull();
    act(() => {
      fireEvent.click(closeBtn as HTMLButtonElement);
    });
    expect(document.querySelector(".snackbar")).toBeNull();
  });

  test("stacks multiple snackbars in show() order", () => {
    const { result } = renderHook(() => useSnackbar(), { wrapper: wrap(60_000) });
    act(() => {
      result.current.show("first");
      result.current.show("second");
    });
    const snackbars = Array.from(document.querySelectorAll(".snackbar"));
    expect(snackbars.map((s) => s.textContent)).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("second"),
    ]);
  });
});

describe("Snackbar — Provider render", () => {
  test("renders children alongside the snackbar stack", () => {
    const { container } = render(
      <SnackbarProvider durationMs={60_000}>
        <p>hello</p>
      </SnackbarProvider>,
    );
    expect(container.textContent).toContain("hello");
  });
});
