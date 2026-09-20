// Reviewer Submit when the post fails (issue #268).
//
// Step outcomes never throw — a failed post parks the Comment back as
// draft + lastError — so the surface has to read LocalState afterwards.
// These tests drive the real App against a failing Transport and assert
// the three things that were silent before: the Snackbar, the sidebar
// error on the failed draft, and that the reviewer's persisted edits
// survive a submit that posted nothing.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PullRequestRepository } from "../lib/pr/repository";
import { InMemoryStorageAdapter } from "../lib/pr/storage";
import type { Transport } from "../lib/pr/transport";
import { emptyState } from "../lib/pr/types";

const BASE = "a\nb\nc\nd\ne\n";
/** One changed line -> one suggestion hunk. */
const EDITED_ONE = "a\nB\nc\nd\ne\n";
/** Two non-adjacent changed lines -> two suggestion hunks. */
const EDITED_TWO = "a\nB\nc\nD\ne\n";
const EDITS_KEY = "pr:o/r#1:suggestion-edits";

const store: Record<string, unknown> = {};
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

let repository: PullRequestRepository;

// App reaches chrome.storage and the PR bootstrap through these two modules
// and offers no injection point for either, so they are stubbed. bun's module
// mocks are process-wide and mutate the live namespace, so the real exports
// are copied out by value first and handed back in afterAll — otherwise the
// rest of the suite would run against these stubs.
const realBrowser = { ...(await import("wxt/browser")) };
const realBootstrap = { ...(await import("../lib/pr/bootstrap")) };

mock.module("wxt/browser", () => ({ browser: { storage: { local } } }));
mock.module("../lib/pr/bootstrap", () => ({
  bootstrapPullRequest: async () => ({ repository, refresh: async () => {} }),
}));

// The open file's content is fetched through the real remote-fetcher, so the
// GitHub contents endpoint is stubbed at the fetch layer instead.
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () =>
    new Response(JSON.stringify({ content: btoa(BASE), encoding: "base64" }), {
      headers: { "content-type": "application/json" },
    }),
  { preconnect: realFetch.preconnect },
) as typeof fetch;

const { App } = await import("../entrypoints/review/App");

afterAll(() => {
  mock.module("wxt/browser", () => realBrowser);
  mock.module("../lib/pr/bootstrap", () => realBootstrap);
  globalThis.fetch = realFetch;
});

const POST_FAILURE = { message: "422 Unprocessable" };

function failingTransport(): Transport {
  return {
    async postReviewBatch() {
      return { ok: false, error: POST_FAILURE };
    },
    async postReply() {
      return { ok: false, error: POST_FAILURE };
    },
    async postIssueComment() {
      return { ok: false, error: POST_FAILURE };
    },
    async resolveReviewThread() {
      return { ok: true };
    },
    async unresolveReviewThread() {
      return { ok: true };
    },
    async commit() {
      return { ok: true, newHeadSha: "h" };
    },
  };
}

function happyTransport(): Transport {
  let nextRemoteId = 100;
  return {
    async postReviewBatch(step) {
      return {
        ok: true,
        mappings: step.comments.map((c) => ({
          cid: c.id,
          remoteId: nextRemoteId++,
          remoteThreadId: `T${c.id}`,
        })),
      };
    },
    async postReply(step) {
      return { ok: true, mapping: { cid: step.comment.id, remoteId: nextRemoteId++ } };
    },
    async postIssueComment(step) {
      return { ok: true, mapping: { cid: step.comment.id, remoteId: nextRemoteId++ } };
    },
    async resolveReviewThread() {
      return { ok: true };
    },
    async unresolveReviewThread() {
      return { ok: true };
    },
    async commit() {
      return { ok: true, newHeadSha: "h" };
    },
  };
}

/** Render App as a reviewer on a PR whose one .md file already carries a
 *  persisted suggestion edit, then submit it. */
async function submitWith(transport: Transport, edited: string): Promise<HTMLElement> {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, {
    github_token: "tok",
    auth_method: "app",
    [EDITS_KEY]: {
      "README.md": { base: BASE, source: edited, baseSha: "h", comments: {} },
    },
  });
  repository = new PullRequestRepository({
    storage: new InMemoryStorageAdapter(),
    transport,
    isInDiff: () => true,
  });
  await repository.setRemoteState({
    ...emptyState(),
    pullRequest: {
      owner: "o",
      repo: "r",
      number: 1,
      title: "Some PR",
      body: "",
      headSha: "h",
      headRef: "topic",
      baseRef: "main",
      state: "open",
      draft: false,
      merged: false,
      // The viewer is not the author, so App derives the reviewer role.
      author: { login: "alice" },
    },
    viewer: { login: "bob" },
    fileContents: [{ sha: "h", path: "README.md", source: BASE }],
    changedFiles: [
      {
        path: "README.md",
        status: "modified",
        patch: "@@ -1,5 +1,5 @@\n-a0\n+a\n b\n c\n d\n e\n",
      },
    ],
  });

  // App reads the PR ref off the query string at render time. The document
  // starts at about:blank, where history.replaceState can't set one.
  (globalThis as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
    "https://localhost/?owner=o&repo=r&pr=1",
  );
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<App />));
  });
  await waitFor(() => {
    expect(container.querySelector(".topbar__pr-title")).not.toBeNull();
  });

  const submit = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.startsWith("Submit review ("),
  );
  expect(submit).toBeDefined();
  await act(async () => {
    fireEvent.click(submit as HTMLButtonElement);
  });
  const confirm = container.querySelector(".modal__footer .btn--primary");
  expect(confirm).not.toBeNull();
  await act(async () => {
    fireEvent.click(confirm as HTMLButtonElement);
  });
  return container;
}

function storedEdits(): Record<string, unknown> {
  return (store[EDITS_KEY] as Record<string, unknown> | undefined) ?? {};
}

afterEach(() => {
  cleanup();
});

describe("App — reviewer submit whose comments fail to post", () => {
  test("announces the error via the Snackbar", async () => {
    const container = await submitWith(failingTransport(), EDITED_ONE);
    await waitFor(() => {
      expect(container.querySelector(".snackbar")?.textContent).toContain("422 Unprocessable");
    });
    expect(container.querySelector(".modal")).toBeNull();
  });

  test("keeps the reviewer's persisted edits instead of discarding them", async () => {
    await submitWith(failingTransport(), EDITED_ONE);
    await waitFor(() => {
      expect(Object.keys(storedEdits())).toEqual(["README.md"]);
    });
  });

  test("shows the error on the failed draft in the sidebar", async () => {
    const container = await submitWith(failingTransport(), EDITED_ONE);
    await waitFor(() => {
      const failed = container.querySelector(".comment--pending .notice--error");
      expect(failed?.textContent).toContain("422 Unprocessable");
    });
  });

  test("says how many comments failed when more than one did", async () => {
    const container = await submitWith(failingTransport(), EDITED_TWO);
    await waitFor(() => {
      expect(container.querySelector(".snackbar")?.textContent).toContain("2 comments");
    });
  });
});

describe("App — reviewer submit that succeeds", () => {
  test("still discards the persisted edits", async () => {
    const container = await submitWith(happyTransport(), EDITED_ONE);
    await waitFor(() => {
      expect(Object.keys(storedEdits())).toEqual([]);
    });
    expect(container.querySelector(".snackbar")).toBeNull();
  });
});
