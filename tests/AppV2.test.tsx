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
