import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import {
  useVisibilityRefresh,
  VISIBILITY_THRESHOLD_MS,
} from "../entrypoints/review/hooks/useVisibilityRefresh";

let nowSpy: ReturnType<typeof spyOn> | null = null;
let now = 0;

function mockNow() {
  now = 1_000_000;
  nowSpy = spyOn(Date, "now").mockImplementation(() => now);
}

afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = null;
  cleanup();
});

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useVisibilityRefresh (ADR 0005 §1)", () => {
  test("refreshes when the tab returns after ≥ the threshold", () => {
    mockNow();
    const onRefresh = mock(async () => {});
    renderHook(() => useVisibilityRefresh(onRefresh));

    setVisibility("hidden");
    now += VISIBILITY_THRESHOLD_MS;
    setVisibility("visible");

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test("does NOT refresh on a brief tab switch (< threshold)", () => {
    mockNow();
    const onRefresh = mock(async () => {});
    renderHook(() => useVisibilityRefresh(onRefresh));

    setVisibility("hidden");
    now += VISIBILITY_THRESHOLD_MS - 1;
    setVisibility("visible");

    expect(onRefresh).not.toHaveBeenCalled();
  });

  test("does NOT refresh on a visible event without a preceding hidden", () => {
    mockNow();
    const onRefresh = mock(async () => {});
    renderHook(() => useVisibilityRefresh(onRefresh));

    setVisibility("visible");

    expect(onRefresh).not.toHaveBeenCalled();
  });

  test("a null callback is a no-op (refresh not wired yet)", () => {
    mockNow();
    renderHook(() => useVisibilityRefresh(null));

    setVisibility("hidden");
    now += VISIBILITY_THRESHOLD_MS;
    // Must not throw on the visible edge with no callback.
    setVisibility("visible");
  });

  test("unmount removes the listener", () => {
    mockNow();
    const onRefresh = mock(async () => {});
    const { unmount } = renderHook(() => useVisibilityRefresh(onRefresh));
    unmount();

    setVisibility("hidden");
    now += VISIBILITY_THRESHOLD_MS;
    setVisibility("visible");

    expect(onRefresh).not.toHaveBeenCalled();
  });
});
