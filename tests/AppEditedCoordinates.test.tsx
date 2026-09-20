// New comment anchors while the editor shows locally edited text (issue #283).
//
// `displayPosition` and `Comment.anchor` live in head coordinates; the editor
// may show the reviewer's edited copy. These tests drive the real App with two
// lines inserted above the commented text and assert the two halves of the
// bridge: a comment on unedited text is recorded in head coordinates, and a
// selection touching a locally edited line is refused instead of anchored to
// text GitHub does not have.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { PullRequestRepository } from "../lib/pr/repository";
import { InMemoryStorageAdapter } from "../lib/pr/storage";
import type { Transport } from "../lib/pr/transport";
import { emptyState } from "../lib/pr/types";

const BASE = "a\nb\nc\nd\ne\n";
/** Two lines inserted above the whole file: head line N is edited line N + 2. */
const EDITED = `X\nY\n${BASE}`;
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

// Same stubbing contract as tests/AppSubmitFailure.test.tsx: App reaches
// chrome.storage and the PR bootstrap through modules with no injection point,
// and bun's module mocks are process-wide, so the real exports are restored.
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

// happy-dom has no layout, so CodeMirror's coordsAtPos returns null and the
// selection bubble would never appear. A fixed rect is enough: the bubble's
// position is irrelevant here, only that selecting text offers the composer.
const realCoordsAtPos = EditorView.prototype.coordsAtPos;
EditorView.prototype.coordsAtPos = () => ({ top: 0, bottom: 10, left: 0, right: 5 });

const { App } = await import("../entrypoints/review/App");

afterAll(() => {
  mock.module("wxt/browser", () => realBrowser);
  mock.module("../lib/pr/bootstrap", () => realBootstrap);
  globalThis.fetch = realFetch;
  EditorView.prototype.coordsAtPos = realCoordsAtPos;
});

function happyTransport(): Transport {
  return {
    async postReviewBatch(step) {
      return { ok: true, mappings: step.comments.map((c) => ({ cid: c.id, remoteId: 1 })) };
    },
    async postReply(step) {
      return { ok: true, mapping: { cid: step.comment.id, remoteId: 2 } };
    },
    async postIssueComment(step) {
      return { ok: true, mapping: { cid: step.comment.id, remoteId: 3 } };
    },
    async resolveReviewThread() {
      return { ok: true };
    },
    async unresolveReviewThread() {
      return { ok: true };
    },
    async setIssueThreadResolved() {
      return { ok: true };
    },
    async commit() {
      return { ok: true, newHeadSha: "h" };
    },
  };
}

/** Render App as a reviewer whose one .md file carries the two inserted lines. */
async function renderEditing(): Promise<HTMLElement> {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, {
    github_token: "tok",
    auth_method: "app",
    [EDITS_KEY]: {
      "README.md": { base: BASE, source: EDITED, baseSha: "h", comments: {} },
    },
  });
  repository = new PullRequestRepository({
    storage: new InMemoryStorageAdapter(),
    transport: happyTransport(),
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
      headRepo: { owner: "o", repo: "r" },
      baseRef: "main",
      state: "open",
      draft: false,
      merged: false,
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
  await waitFor(() => {
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
    expect(view?.state.doc.toString()).toBe(EDITED);
  });
  return container;
}

/** Select `[from, to)` in the editor, open the composer and add a comment. */
async function comment(container: HTMLElement, from: number, to: number): Promise<void> {
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
  await act(async () => {
    view?.dispatch({ selection: { anchor: from, head: to } });
  });
  await waitFor(() => {
    expect(container.querySelector(".selection-bubble")).not.toBeNull();
  });
  await act(async () => {
    fireEvent.click(container.querySelector(".selection-bubble") as HTMLButtonElement);
  });
  const textarea = await waitFor(() => {
    const el = container.querySelector(".review-item--composer textarea");
    expect(el).not.toBeNull();
    return el as HTMLTextAreaElement;
  });
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "please look" } });
  });
  const add = Array.from(container.querySelectorAll(".review-item--composer button")).find(
    (b) => b.textContent === "Add",
  ) as HTMLButtonElement;
  await act(async () => {
    fireEvent.click(add);
  });
}

afterEach(() => {
  cleanup();
});

describe("App — commenting while lines are inserted above (issue #283)", () => {
  test("a comment on unedited text is anchored in head coordinates", async () => {
    const container = await renderEditing();
    // "b" is head line 2, but edited line 4 — offsets 6..7 in the edited doc.
    await comment(container, 6, 7);
    await waitFor(() => {
      expect(repository.getLocalState().comments).toHaveLength(1);
    });
    expect(repository.getLocalState().comments[0]?.anchor).toEqual({
      sha: "h",
      range: { sl: 2, sc: 1, el: 2, ec: 2 },
      quote: "b",
    });
  });

  test("a selection on a locally inserted line is refused with a message", async () => {
    const container = await renderEditing();
    // "X" is edited line 1; it exists in no revision GitHub has.
    await comment(container, 0, 1);
    await waitFor(() => {
      expect(container.querySelector(".snackbar")?.textContent).toContain("unsubmitted edits");
    });
    expect(repository.getLocalState().comments).toHaveLength(0);
  });
});
