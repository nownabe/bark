import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { beforeEach, describe, expect, mock, test } from "bun:test";

// The background worker relies on WXT auto-import globals; provide them so the
// entrypoint module can be imported and its message listener driven directly.
(globalThis as Record<string, unknown>).defineBackground = (main: unknown) => main;

interface FakeTab {
  id?: number;
  windowId?: number;
  url?: string;
}

const tabsQuery = mock(async (_info: { url: string }): Promise<FakeTab[]> => []);
const tabsUpdate = mock(async (_id: number, _props: { active: boolean }) => {});
const tabsCreate = mock(async (_props: { url: string }) => {});
const windowsUpdate = mock(async (_id: number, _props: { focused: boolean }) => {});

let listener: (message: unknown) => unknown;

(globalThis as Record<string, unknown>).browser = {
  runtime: {
    getURL: (path: string) => `chrome-extension://bark${path}`,
    onMessage: {
      addListener: (fn: (message: unknown) => unknown) => {
        listener = fn;
      },
    },
  },
  tabs: { query: tabsQuery, update: tabsUpdate, create: tabsCreate },
  windows: { update: windowsUpdate },
};

const main = (await import("../entrypoints/background")).default as unknown as () => void;
main();

const REVIEW_URL = "chrome-extension://bark/review.html";

function open(pr = "7") {
  return listener({ type: "bark/open", ref: { owner: "o", repo: "r", pr } });
}

// The listener fires the tab work without awaiting it; let the microtasks run.
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  tabsQuery.mockClear();
  tabsUpdate.mockClear();
  tabsCreate.mockClear();
  windowsUpdate.mockClear();
  tabsQuery.mockImplementation(async () => []);
});

describe("background — one review tab per PR (#277)", () => {
  test("focuses the existing review tab for the same PR instead of opening another", async () => {
    tabsQuery.mockImplementation(async () => [
      { id: 5, windowId: 2, url: `${REVIEW_URL}?owner=o&repo=r&pr=7` },
    ]);

    open();
    await flush();

    expect(tabsUpdate).toHaveBeenCalledWith(5, { active: true });
    expect(windowsUpdate).toHaveBeenCalledWith(2, { focused: true });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  test("matches regardless of query-parameter order", async () => {
    tabsQuery.mockImplementation(async () => [
      { id: 5, windowId: 2, url: `${REVIEW_URL}?pr=7&repo=r&owner=o` },
    ]);

    open();
    await flush();

    expect(tabsUpdate).toHaveBeenCalledWith(5, { active: true });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  test("opens a new tab when no review tab matches the PR", async () => {
    tabsQuery.mockImplementation(async () => [
      { id: 5, windowId: 2, url: `${REVIEW_URL}?owner=o&repo=r&pr=8` },
    ]);

    open();
    await flush();

    expect(tabsCreate).toHaveBeenCalledTimes(1);
    expect(tabsCreate).toHaveBeenCalledWith({ url: `${REVIEW_URL}?owner=o&repo=r&pr=7` });
    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  test("treats a tab without a url as no match", async () => {
    tabsQuery.mockImplementation(async () => [{ id: 5, windowId: 2 }]);

    open();
    await flush();

    expect(tabsCreate).toHaveBeenCalledTimes(1);
  });
});
