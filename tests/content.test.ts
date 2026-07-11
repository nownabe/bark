import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// The content script relies on WXT auto-import globals; provide them so the
// entrypoint module can be imported and driven directly in tests.
(globalThis as Record<string, unknown>).defineContentScript = (definition: unknown) => definition;
const sentMessages: unknown[] = [];
(globalThis as Record<string, unknown>).browser = {
  runtime: {
    getURL: (path: string) => `chrome-extension://bark${path}`,
    sendMessage: async (message: unknown) => {
      sentMessages.push(message);
    },
  },
};

const contentScript = (await import("../entrypoints/content")).default as {
  matches: string[];
  main: () => void;
};

function setUrl(url: string) {
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url);
}

function turboNavigateTo(url: string) {
  setUrl(url);
  document.dispatchEvent(new Event("turbo:load"));
}

beforeEach(() => {
  document.body.innerHTML = "";
  sentMessages.length = 0;
});

afterEach(() => {
  document.getElementById("bark-entry")?.remove();
});

describe("content script registration", () => {
  test("matches every github.com page so Turbo nav from non-PR pages is covered (#189)", () => {
    expect(contentScript.matches).toEqual(["https://github.com/*"]);
  });
});

describe("entry button injection", () => {
  test("injects the button when loaded directly on a PR page", () => {
    setUrl("https://github.com/owner/repo/pull/42");
    contentScript.main();
    expect(document.getElementById("bark-entry")).not.toBeNull();
  });

  test("does not inject on a non-PR page", () => {
    setUrl("https://github.com/owner/repo/pulls");
    contentScript.main();
    expect(document.getElementById("bark-entry")).toBeNull();
  });

  test("injects after Turbo navigation from the pulls list to a PR (#189)", () => {
    setUrl("https://github.com/owner/repo/pulls");
    contentScript.main();
    expect(document.getElementById("bark-entry")).toBeNull();

    turboNavigateTo("https://github.com/owner/repo/pull/42");
    expect(document.getElementById("bark-entry")).not.toBeNull();
  });

  test("clicking after Turbo navigation to another PR sends the current PR ref (#87)", () => {
    setUrl("https://github.com/owner/repo/pull/42");
    contentScript.main();

    turboNavigateTo("https://github.com/owner/repo/pull/43");
    document.getElementById("bark-entry")?.click();

    expect(sentMessages).toEqual([
      { type: "bark/open", ref: { owner: "owner", repo: "repo", pr: "43" } },
    ]);
  });

  test("removes the button when Turbo navigation leaves the PR page", () => {
    setUrl("https://github.com/owner/repo/pull/42");
    contentScript.main();
    expect(document.getElementById("bark-entry")).not.toBeNull();

    turboNavigateTo("https://github.com/owner/repo/pulls");
    expect(document.getElementById("bark-entry")).toBeNull();
  });
});
