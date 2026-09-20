// The PR ref comes from the review page's query string, which is untrusted
// input (issue #295): a non-numeric, zero or negative `pr` must never reach
// the GitHub API paths and storage keys the bootstrap builds from it.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const store: Record<string, unknown> = { github_token: "tok", auth_method: "app" };
const local = {
  async get(key: string | string[] | null) {
    const keys = key === null ? Object.keys(store) : Array.isArray(key) ? key : [key];
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in store) out[k] = store[k];
    return out;
  },
  async set(items: Record<string, unknown>) {
    Object.assign(store, items);
  },
  async remove(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
  },
};

let bootstrapCalls = 0;

// Same stubbing dance as AppSubmitFailure.test.tsx: bun's module mocks are
// process-wide, so the real exports are copied out by value and restored in
// afterAll.
const realBrowser = { ...(await import("wxt/browser")) };
const realBootstrap = { ...(await import("../lib/pr/bootstrap")) };

mock.module("wxt/browser", () => ({ browser: { storage: { local } } }));
mock.module("../lib/pr/bootstrap", () => ({
  bootstrapPullRequest: async () => {
    bootstrapCalls++;
    throw new Error("stub bootstrap");
  },
}));

const { App } = await import("../entrypoints/review/App");

afterAll(() => {
  mock.module("wxt/browser", () => realBrowser);
  mock.module("../lib/pr/bootstrap", () => realBootstrap);
});

afterEach(() => {
  cleanup();
});

async function renderAt(pr: string): Promise<HTMLElement> {
  bootstrapCalls = 0;
  (globalThis as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
    `https://localhost/?owner=o&repo=r&pr=${pr}`,
  );
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<App />));
  });
  return container;
}

describe("App — PR number from the query string", () => {
  for (const pr of ["abc", "0", "-1", "1.5"]) {
    test(`renders an error and never bootstraps for ?pr=${pr}`, async () => {
      const container = await renderAt(pr);
      expect(container.querySelector(".notice--error")?.textContent).toContain("PR number");
      expect(bootstrapCalls).toBe(0);
    });
  }

  test("bootstraps for a positive integer", async () => {
    await renderAt("1");
    await waitFor(() => {
      expect(bootstrapCalls).toBe(1);
    });
  });
});
