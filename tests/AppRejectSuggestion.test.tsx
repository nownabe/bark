// Author rejects a reviewer's suggestion (issue #287).
//
// ADR 0002 §7 defines rejection as "the thread is resolved, with no
// corresponding commit". Reject therefore has to reach GitHub through the
// same immediate path as the Resolve button, and must leave nothing behind
// in the local dismissed map — a local-only rejection is invisible to the
// reviewer and diverges per browser.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PullRequestRepository } from "../lib/pr/repository";
import { InMemoryStorageAdapter } from "../lib/pr/storage";
import type { Transport } from "../lib/pr/transport";
import { emptyState } from "../lib/pr/types";

const BASE = "a\nb\nc\nd\ne\n";
const DISMISSED_KEY = "pr:o/r#1:dismissed-suggestions";

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

afterEach(cleanup);

function recordingTransport(calls: string[]): Transport {
  return {
    async postReviewBatch() {
      calls.push("post-review-batch");
      return { ok: true, mappings: [] };
    },
    async postReply(step) {
      calls.push("post-reply");
      return { ok: true, mapping: { cid: step.comment.id, remoteId: 1 } };
    },
    async postIssueComment(step) {
      calls.push("post-issue-comment");
      return { ok: true, mapping: { cid: step.comment.id, remoteId: 1 } };
    },
    async resolveReviewThread() {
      calls.push("resolve-review-thread");
      return { ok: true };
    },
    async unresolveReviewThread() {
      calls.push("unresolve-review-thread");
      return { ok: true };
    },
    async setIssueThreadResolved() {
      calls.push("set-issue-thread-resolved");
      return { ok: true };
    },
    async commit() {
      calls.push("commit");
      return { ok: true, newHeadSha: "h" };
    },
  };
}

const SUGGESTION_COMMENT = {
  id: "c-sug",
  state: "synced" as const,
  remoteId: 100,
  remoteKind: "review" as const,
  threadId: "t-sug",
  body: "swap\n\n```suggestion\nB\n```",
  author: { login: "bob" },
  path: "README.md",
  anchor: { sha: "h", range: { sl: 2, sc: 1, el: 2, ec: 1 }, quote: "b\n" },
};

const SUGGESTION_THREAD = {
  id: "t-sug",
  state: "synced" as const,
  remoteThreadId: "PRT_1",
  resolved: false,
  viewerCanResolve: true,
};

/** Render App as the PR author looking at a reviewer's submitted suggestion. */
async function renderAsAuthor(calls: string[]): Promise<HTMLElement> {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, { github_token: "tok", auth_method: "app" });
  repository = new PullRequestRepository({
    storage: new InMemoryStorageAdapter(),
    transport: recordingTransport(calls),
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
      // The viewer IS the author, so App derives the author role.
      author: { login: "alice" },
    },
    viewer: { login: "alice" },
    comments: [SUGGESTION_COMMENT],
    threads: [SUGGESTION_THREAD],
    fileContents: [{ sha: "h", path: "README.md", source: BASE }],
    changedFiles: [
      {
        path: "README.md",
        status: "modified",
        patch: "@@ -1,5 +1,5 @@\n-a0\n+a\n b\n c\n d\n e\n",
      },
    ],
  });
  await repository.upsertComment(SUGGESTION_COMMENT);
  await repository.upsertThread(SUGGESTION_THREAD);

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
  return container;
}

describe("App — author rejects a suggestion (issue #287)", () => {
  test("resolves the thread through the transport and stores no local decision", async () => {
    const calls: string[] = [];
    const container = await renderAsAuthor(calls);

    const reject = await waitFor(() => {
      const btn = Array.from(container.querySelectorAll(".comment__actions button")).find(
        (b) => b.textContent === "Reject",
      );
      expect(btn).toBeDefined();
      return btn as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(reject);
    });

    await waitFor(() => {
      expect(calls).toEqual(["resolve-review-thread"]);
    });
    expect(repository.getLocalState().threads[0]?.resolved).toBe(true);
    expect(store[DISMISSED_KEY] ?? {}).toEqual({});
    // A rejected suggestion is a resolved thread; its author actions go away.
    await waitFor(() => {
      expect(container.querySelector(".comment__actions")).toBeNull();
    });
  });
});
