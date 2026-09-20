import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PullRequestRepository } from "../lib/pr/repository";
import { InMemoryStorageAdapter } from "../lib/pr/storage";
import type { Transport } from "../lib/pr/transport";
import { AppV2 } from "../entrypoints/review/AppV2";

afterEach(() => {
  cleanup();
});

function noopTransport(): Transport {
  return {
    async postReviewBatch() {
      return { ok: true, mappings: [] };
    },
    async postReply(step) {
      return { ok: true, mapping: { cid: step.comment.id, remoteId: 0 } };
    },
    async postIssueComment(step) {
      return { ok: true, mapping: { cid: step.comment.id, remoteId: 0 } };
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
      return { ok: true, newHeadSha: "" };
    },
  };
}

function makeRepo() {
  return new PullRequestRepository({
    storage: new InMemoryStorageAdapter(),
    transport: noopTransport(),
    isInDiff: () => true,
  });
}

const author = { login: "alice" };
const anchor = {
  sha: "h",
  range: { sl: 1, sc: 1, el: 1, ec: 6 },
  quote: "hello",
};

describe("AppV2 — initial render", () => {
  test("shows a loading state when no PullRequest is loaded yet", () => {
    const repo = makeRepo();
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);
    expect(container.textContent).toContain("Loading PR");
  });

  test("renders PR metadata, viewer, role, and an empty-threads message", async () => {
    const repo = makeRepo();
    await repo.setRemoteState({
      ...repo.getRemoteState(),
      pullRequest: {
        owner: "acme",
        repo: "site",
        number: 42,
        title: "Add docs",
        body: "",
        headSha: "h",
        headRef: "topic",
        baseRef: "main",
        state: "open",
        draft: false,
        merged: false,
        author: { login: "carol" },
      },
      viewer: { login: "alice" },
    });
    const { container, getByTestId } = render(<AppV2 repository={repo} refresh={async () => {}} />);
    expect(container.textContent).toContain("Add docs");
    expect(container.textContent).toContain("acme/site#42");
    expect(container.textContent).toContain("@alice");
    expect(container.textContent).toContain("reviewer");
    expect(getByTestId("threads").textContent).toContain("No threads yet");
  });
});

describe("AppV2 — threads + comments", () => {
  test("groups comments by thread and surfaces draft / suggestion badges", async () => {
    const repo = makeRepo();
    await repo.setRemoteState({
      ...repo.getRemoteState(),
      pullRequest: {
        owner: "acme",
        repo: "site",
        number: 1,
        title: "T",
        body: "",
        headSha: "h",
        headRef: "topic",
        baseRef: "main",
        state: "open",
        draft: false,
        merged: false,
        author: { login: "alice" },
      },
      viewer: { login: "alice" },
    });
    await repo.upsertThread({
      id: "t1",
      state: "synced",
      remoteThreadId: "PRT_a",
      resolved: false,
    });
    await repo.upsertComment({
      id: "c1",
      state: "synced",
      remoteId: 10,
      threadId: "t1",
      body: "Looks good",
      author,
      path: "f.md",
      anchor,
    });
    await repo.upsertComment({
      id: "c2",
      state: "draft",
      threadId: "t1",
      body: "Try:\n```suggestion\nfixed\n```",
      author,
      path: "f.md",
      anchor,
    });

    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);
    expect(container.textContent).toContain("Looks good");
    expect(container.textContent).toContain("draft");
    expect(container.textContent).toContain("suggestion");
  });

  test("shows a resolved badge when Thread.resolved is true", async () => {
    const repo = makeRepo();
    await repo.setRemoteState({
      ...repo.getRemoteState(),
      pullRequest: {
        owner: "acme",
        repo: "site",
        number: 1,
        title: "T",
        body: "",
        headSha: "h",
        headRef: "topic",
        baseRef: "main",
        state: "open",
        draft: false,
        merged: false,
        author: { login: "alice" },
      },
      viewer: { login: "alice" },
    });
    await repo.upsertThread({
      id: "t1",
      state: "synced",
      remoteThreadId: "PRT_a",
      resolved: true,
    });
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);
    expect(container.textContent).toContain("resolved");
  });

  test("foreign comments (no Bark metadata, no matching Thread) still appear", async () => {
    // Reproduces the production state where someone else's review or
    // issue comments live in RemoteState — they get copied into
    // LocalState by mergeRemoteIntoLocal but carry no Thread because
    // there is no embedded metadata to wire them up. The synthetic
    // ThreadGroup keeps them visible.
    const repo = makeRepo();
    await repo.setRemoteState({
      ...repo.getRemoteState(),
      pullRequest: {
        owner: "acme",
        repo: "site",
        number: 1,
        title: "T",
        body: "",
        headSha: "h",
        headRef: "topic",
        baseRef: "main",
        state: "open",
        draft: false,
        merged: false,
        author: { login: "alice" },
      },
      viewer: { login: "alice" },
    });
    await repo.upsertComment({
      id: "foreign-review-42",
      state: "synced",
      remoteId: 42,
      threadId: "foreign-thread-review-42",
      body: "Drive-by review comment",
      author: { login: "carol" },
      path: "test.md",
      anchor: { sha: "", range: { sl: 7, sc: 1, el: 7, ec: 1 }, quote: "" },
    });
    await repo.upsertComment({
      id: "foreign-issue-50",
      state: "synced",
      remoteId: 50,
      threadId: "foreign-thread-issue-50",
      body: "Top-level discussion",
      author: { login: "dan" },
      path: "",
      anchor: { sha: "", range: { sl: 1, sc: 1, el: 1, ec: 1 }, quote: "" },
    });

    const { container, getByTestId } = render(<AppV2 repository={repo} refresh={async () => {}} />);
    expect(container.textContent).toContain("Drive-by review comment");
    expect(container.textContent).toContain("Top-level discussion");
    expect(container.textContent).toContain("@carol");
    expect(container.textContent).toContain("@dan");
    // path:line surfaces for review comments so the reader has a rough
    // location; issue comments have no path, so we render a "(no file)"
    // hint instead of an empty span.
    expect(getByTestId("location-foreign-review-42").textContent).toContain("test.md");
    expect(getByTestId("location-foreign-review-42").textContent).toContain("L7");
    expect(getByTestId("location-foreign-issue-50").textContent).toContain("(no file)");
  });
});

describe("AppV2 — draft creation and submission", () => {
  async function withPullRequest(repo: PullRequestRepository) {
    await repo.setRemoteState({
      ...repo.getRemoteState(),
      pullRequest: {
        owner: "acme",
        repo: "site",
        number: 1,
        title: "T",
        body: "",
        headSha: "h",
        headRef: "topic",
        baseRef: "main",
        state: "open",
        draft: false,
        merged: false,
        author: { login: "carol" },
      },
      viewer: { login: "alice" },
    });
  }

  test("the new-comment form renders with all required fields", async () => {
    const repo = makeRepo();
    await withPullRequest(repo);
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);
    expect(container.querySelector("[data-testid='new-comment-form']")).not.toBeNull();
    expect(container.querySelector("[data-testid='new-comment-body']")).not.toBeNull();
    // The "Submit drafts" header button is hidden when there are no drafts.
    expect(container.querySelector("[data-testid='submit-drafts']")).toBeNull();
  });

  test("a draft Comment created via the Repository appears in the rendered list with the submit button", async () => {
    const repo = makeRepo();
    await withPullRequest(repo);
    const { container, getByText } = render(<AppV2 repository={repo} refresh={async () => {}} />);
    await act(async () => {
      await repo.upsertThread({ id: "t-x", state: "draft", resolved: false });
      await repo.upsertComment({
        id: "c-x",
        state: "draft",
        threadId: "t-x",
        body: "looks suspicious",
        author: { login: "alice" },
        path: "f.md",
        anchor,
      });
    });
    expect(container.textContent).toContain("looks suspicious");
    expect(getByText(/Submit 1 draft/).tagName).toBe("BUTTON");
  });

  test("empty body shows a warning Snackbar and does not create a draft", async () => {
    const repo = makeRepo();
    await withPullRequest(repo);
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);

    const form = container.querySelector("[data-testid='new-comment-form']") as HTMLFormElement;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(document.querySelector(".snackbar--warning")).not.toBeNull();
    });
    expect(document.querySelector(".snackbar--warning")?.textContent).toContain("empty");
    expect(repo.getLocalState().comments.length).toBe(0);
  });

  test("Discard removes a draft Comment", async () => {
    const repo = makeRepo();
    await withPullRequest(repo);
    await repo.upsertThread({ id: "t1", state: "draft", resolved: false });
    await repo.upsertComment({
      id: "c1",
      state: "draft",
      threadId: "t1",
      body: "tentative",
      author,
      path: "f.md",
      anchor,
    });
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);

    const discardBtn = container.querySelector("[data-testid='discard-c1']") as HTMLButtonElement;
    expect(discardBtn).not.toBeNull();
    fireEvent.click(discardBtn);

    await waitFor(() => {
      expect(repo.getLocalState().comments.find((c) => c.id === "c1")).toBeUndefined();
    });
  });

  test("Submit drafts triggers the Repository pipeline and marks comments synced", async () => {
    let nextRemoteId = 100;
    const transport: Transport = {
      ...noopTransport(),
      async postReviewBatch(step) {
        return {
          ok: true,
          mappings: step.comments.map((c, idx) => ({
            cid: c.id,
            remoteId: nextRemoteId++,
            ...(idx === 0 ? { remoteThreadId: "PRT_new" } : {}),
          })),
        };
      },
    };
    const repo = new PullRequestRepository({
      storage: new InMemoryStorageAdapter(),
      transport,
      isInDiff: () => true,
    });
    await withPullRequest(repo);
    await repo.upsertThread({ id: "t1", state: "draft", resolved: false });
    await repo.upsertComment({
      id: "c1",
      state: "draft",
      threadId: "t1",
      body: "needs work",
      author,
      path: "f.md",
      anchor,
    });
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);

    const submitBtn = container.querySelector("[data-testid='submit-drafts']") as HTMLButtonElement;
    expect(submitBtn).not.toBeNull();
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(repo.getLocalState().comments[0]?.state).toBe("synced");
    });
    expect(repo.getLocalState().comments[0]?.remoteId).toBe(100);
  });
});

describe("AppV2 — Resolve / Unresolve", () => {
  async function withPrAndThread(repo: PullRequestRepository, resolved: boolean) {
    // Remote first — so reconcile sees a coherent prior state and can
    // diff against any local toggle.
    await repo.setRemoteState({
      ...repo.getRemoteState(),
      pullRequest: {
        owner: "acme",
        repo: "site",
        number: 1,
        title: "T",
        body: "",
        headSha: "h",
        headRef: "topic",
        baseRef: "main",
        state: "open",
        draft: false,
        merged: false,
        author: { login: "carol" },
      },
      viewer: { login: "alice" },
      threads: [
        {
          id: "t1",
          state: "synced",
          remoteThreadId: "PRT_a",
          resolved,
        },
      ],
      comments: [
        {
          id: "c1",
          state: "synced",
          remoteId: 10,
          threadId: "t1",
          body: "comment",
          author,
          path: "f.md",
          anchor,
        },
      ],
    });
  }

  test("Resolve button is hidden for draft threads", async () => {
    const repo = makeRepo();
    await repo.setRemoteState({
      ...repo.getRemoteState(),
      pullRequest: {
        owner: "a",
        repo: "b",
        number: 1,
        title: "T",
        body: "",
        headSha: "h",
        headRef: "t",
        baseRef: "m",
        state: "open",
        draft: false,
        merged: false,
        author: { login: "x" },
      },
      viewer: { login: "alice" },
    });
    await repo.upsertThread({ id: "tt", state: "draft", resolved: false });
    await repo.upsertComment({
      id: "cc",
      state: "draft",
      threadId: "tt",
      body: "x",
      author,
      path: "f.md",
      anchor,
    });
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);
    expect(container.querySelector("[data-testid='resolve-tt']")).toBeNull();
  });

  test("Resolve button on a synced thread runs setThreadResolved and lands as resolved", async () => {
    let resolveCalled = false;
    const transport: Transport = {
      ...noopTransport(),
      async resolveReviewThread() {
        resolveCalled = true;
        return { ok: true };
      },
    };
    const repo = new PullRequestRepository({
      storage: new InMemoryStorageAdapter(),
      transport,
      isInDiff: () => true,
    });
    await withPrAndThread(repo, false);
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);

    const btn = container.querySelector("[data-testid='resolve-t1']") as HTMLButtonElement;
    expect(btn?.textContent).toBe("Resolve");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(repo.getLocalState().threads[0]?.resolved).toBe(true);
    });
    expect(resolveCalled).toBe(true);
    expect(repo.getLocalState().threads[0]?.state).toBe("synced");
  });

  test("an already-resolved thread shows Unresolve and toggles back", async () => {
    let unresolveCalled = false;
    const transport: Transport = {
      ...noopTransport(),
      async unresolveReviewThread() {
        unresolveCalled = true;
        return { ok: true };
      },
    };
    const repo = new PullRequestRepository({
      storage: new InMemoryStorageAdapter(),
      transport,
      isInDiff: () => true,
    });
    await withPrAndThread(repo, true);
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);

    const btn = container.querySelector("[data-testid='resolve-t1']") as HTMLButtonElement;
    expect(btn?.textContent).toBe("Unresolve");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(repo.getLocalState().threads[0]?.resolved).toBe(false);
    });
    expect(unresolveCalled).toBe(true);
  });
});

describe("AppV2 — Reply", () => {
  async function withSyncedThread(repo: PullRequestRepository) {
    await repo.setRemoteState({
      ...repo.getRemoteState(),
      pullRequest: {
        owner: "a",
        repo: "b",
        number: 1,
        title: "T",
        body: "",
        headSha: "h",
        headRef: "t",
        baseRef: "m",
        state: "open",
        draft: false,
        merged: false,
        author: { login: "carol" },
      },
      viewer: { login: "alice" },
    });
    await repo.upsertThread({
      id: "t1",
      state: "synced",
      remoteThreadId: "PRT_a",
      resolved: false,
    });
    await repo.upsertComment({
      id: "c-root",
      state: "synced",
      remoteId: 10,
      threadId: "t1",
      body: "root",
      author,
      path: "f.md",
      anchor,
    });
  }

  test("Reply button reveals an inline form when clicked", async () => {
    const repo = makeRepo();
    await withSyncedThread(repo);
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);

    expect(container.querySelector("[data-testid='reply-form-t1']")).toBeNull();
    const btn = container.querySelector("[data-testid='reply-t1']") as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='reply-form-t1']")).not.toBeNull();
    });
  });

  test("a reply Comment upserted via Repository inherits parentLocalId and threadId from the root", async () => {
    const repo = makeRepo();
    await withSyncedThread(repo);
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);

    // The Reply path the form takes: clone anchor / path from the root.
    await act(async () => {
      await repo.upsertComment({
        id: "c-reply",
        state: "draft",
        threadId: "t1",
        parentLocalId: "c-root",
        body: "replying",
        author: { login: "alice" },
        path: "f.md",
        anchor,
      });
    });

    expect(container.textContent).toContain("replying");
    const reply = repo.getLocalState().comments.find((c) => c.id === "c-reply");
    expect(reply?.parentLocalId).toBe("c-root");
    expect(reply?.threadId).toBe("t1");
  });
});

describe("AppV2 — SourceViewer", () => {
  async function withPrAndFiles(
    repo: PullRequestRepository,
    files: Array<{ sha: string; path: string; source: string }>,
  ) {
    await repo.setRemoteState({
      ...repo.getRemoteState(),
      pullRequest: {
        owner: "a",
        repo: "b",
        number: 1,
        title: "T",
        body: "",
        headSha: "h",
        headRef: "t",
        baseRef: "m",
        state: "open",
        draft: false,
        merged: false,
        author: { login: "x" },
      },
      viewer: { login: "alice" },
      fileContents: files,
    });
  }

  test("placeholder when no file content is loaded yet", async () => {
    const repo = makeRepo();
    await withPrAndFiles(repo, []);
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);
    expect(container.querySelector("[data-testid='source-viewer']")?.textContent).toContain(
      "No file content loaded yet",
    );
  });

  test("renders a CodeMirror editor for the file at headSha", async () => {
    const repo = makeRepo();
    await withPrAndFiles(repo, [
      { sha: "h", path: "README.md", source: "# Hello\n\nThis is bold." },
    ]);
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);
    const editor = container.querySelector("[data-testid='source-editor']");
    expect(editor).not.toBeNull();
    // The CodeMirror wrapper mounts a `.cm-editor` element when it boots.
    expect(editor?.querySelector(".cm-editor")).not.toBeNull();
    // The source content lands in the editor's content area.
    expect(editor?.textContent).toContain("Hello");
  });

  test("offers a selector when multiple files are loaded and updates the editor on change", async () => {
    const repo = makeRepo();
    await withPrAndFiles(repo, [
      { sha: "h", path: "A.md", source: "alpha line" },
      { sha: "h", path: "B.md", source: "beta line" },
    ]);
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);
    const select = container.querySelector("[data-testid='source-path']") as HTMLSelectElement;
    expect(select).not.toBeNull();
    // Initial: alpha is rendered (first in sorted order).
    expect(container.querySelector("[data-testid='source-editor']")?.textContent).toContain(
      "alpha",
    );
    fireEvent.change(select, { target: { value: "B.md" } });
    await waitFor(() => {
      expect(container.querySelector("[data-testid='source-editor']")?.textContent).toContain(
        "beta",
      );
    });
  });

  test("only files matching headSha are listed", async () => {
    const repo = makeRepo();
    await withPrAndFiles(repo, [
      { sha: "h", path: "current.md", source: "# Current" },
      { sha: "old", path: "past.md", source: "# Past" },
    ]);
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);
    // Only one path at headSha, so no selector is rendered.
    expect(container.querySelector("[data-testid='source-path']")).toBeNull();
    // Editor shows the headSha file content.
    expect(container.querySelector("[data-testid='source-editor']")?.textContent).toContain(
      "Current",
    );
  });
});

describe("AppV2 — NewCommentForm: selection mode", () => {
  test("without a selection, manual range / quote fields are shown", async () => {
    const repo = makeRepo();
    await repo.setRemoteState({
      ...repo.getRemoteState(),
      pullRequest: {
        owner: "a",
        repo: "b",
        number: 1,
        title: "T",
        body: "",
        headSha: "h",
        headRef: "t",
        baseRef: "m",
        state: "open",
        draft: false,
        merged: false,
        author: { login: "x" },
      },
      viewer: { login: "alice" },
    });
    const { container } = render(<AppV2 repository={repo} refresh={async () => {}} />);
    // Range inputs are present; selection banner is absent.
    expect(container.querySelector("[data-testid='selection-banner']")).toBeNull();
    expect(container.querySelectorAll(".appv2__field--narrow").length).toBeGreaterThan(0);
  });
});

describe("AppV2 — refresh button", () => {
  test("calls the provided refresh and shows progress feedback", async () => {
    const repo = makeRepo();
    let resolveRefresh: () => void = () => {};
    const refresh = mock(() => {
      return new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      });
    });
    const { container } = render(<AppV2 repository={repo} refresh={refresh} />);
    const button = container.querySelector("button");
    if (!button) throw new Error("button missing");

    act(() => {
      fireEvent.click(button);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(button.textContent).toContain("Refreshing");

    await act(async () => {
      resolveRefresh();
    });

    await waitFor(() => {
      const btn = container.querySelector("button");
      expect(btn?.textContent).toBe("Refresh");
    });
  });

  test("surfaces refresh errors via the Snackbar", async () => {
    const repo = makeRepo();
    const refresh = mock(async () => {
      throw new Error("network down");
    });
    const { container } = render(<AppV2 repository={repo} refresh={refresh} />);
    const button = container.querySelector("button");
    if (!button) throw new Error("button missing");

    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => {
      const snack = document.querySelector(".snackbar");
      expect(snack?.textContent).toContain("Could not refresh");
      expect(snack?.textContent).toContain("network down");
    });
  });
});
