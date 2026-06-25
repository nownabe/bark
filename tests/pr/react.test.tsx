import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { act, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  RepositoryProvider,
  useAppState,
  useLocalState,
  useRemoteState,
  useRepository,
} from "../../lib/pr/react";
import { PullRequestRepository } from "../../lib/pr/repository";
import { InMemoryStorageAdapter } from "../../lib/pr/storage";
import type { Transport } from "../../lib/pr/transport";
import type { Comment, PullRequest } from "../../lib/pr/types";

const author = { login: "alice" };
const anchor = {
  sha: "h",
  range: { sl: 1, sc: 1, el: 1, ec: 6 },
  quote: "hello",
};

function nullTransport(): Transport {
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
    transport: nullTransport(),
    isInDiff: () => true,
  });
}

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    state: "draft",
    threadId: "t1",
    body: "body",
    author,
    path: "README.md",
    anchor,
    ...overrides,
  };
}

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    owner: "o",
    repo: "r",
    number: 1,
    title: "t",
    body: "b",
    headSha: "h",
    headRef: "topic",
    baseRef: "main",
    state: "open",
    draft: false,
    merged: false,
    author,
    ...overrides,
  };
}

function wrap(repo: PullRequestRepository) {
  return ({ children }: { children: ReactNode }) => (
    <RepositoryProvider repo={repo}>{children}</RepositoryProvider>
  );
}

describe("react — useRepository", () => {
  test("throws when no provider is present", () => {
    expect(() => renderHook(() => useRepository())).toThrow(/RepositoryProvider/);
  });

  test("returns the provided Repository", () => {
    const repo = makeRepo();
    const { result } = renderHook(() => useRepository(), { wrapper: wrap(repo) });
    expect(result.current).toBe(repo);
  });
});

describe("react — useLocalState", () => {
  test("returns the current LocalState and updates after a mutation", async () => {
    const repo = makeRepo();
    const { result } = renderHook(() => useLocalState(), { wrapper: wrap(repo) });
    expect(result.current.comments).toEqual([]);
    await act(async () => {
      await repo.upsertComment(comment());
    });
    expect(result.current.comments).toHaveLength(1);
    expect(result.current.comments[0]?.id).toBe("c1");
  });
});

describe("react — useRemoteState", () => {
  test("returns the current RemoteState and updates on setRemoteState", async () => {
    const repo = makeRepo();
    const { result } = renderHook(() => useRemoteState(), { wrapper: wrap(repo) });
    expect(result.current.pullRequest).toBeNull();
    await act(async () => {
      await repo.setRemoteState({ ...repo.getRemoteState(), pullRequest: pr() });
    });
    expect(result.current.pullRequest?.headSha).toBe("h");
  });
});

describe("react — useAppState", () => {
  test("derives AppState from LocalState + RemoteState", async () => {
    const repo = makeRepo();
    const ctx = { isInDiff: () => true };
    const { result } = renderHook(() => useAppState(ctx), { wrapper: wrap(repo) });

    expect(result.current.role).toBeNull();
    expect(result.current.commentViews.size).toBe(0);

    await act(async () => {
      await repo.setRemoteState({
        ...repo.getRemoteState(),
        pullRequest: pr(),
        viewer: { login: "bob" },
      });
    });
    expect(result.current.role).toBe("reviewer");

    await act(async () => {
      await repo.upsertComment(comment());
    });
    expect(result.current.commentViews.size).toBe(1);
    expect(result.current.commentViews.get("c1")?.isMyDraft).toBe(true);
  });
});

describe("react — RepositoryProvider integration", () => {
  test("children rendered with the Repository can subscribe", () => {
    const repo = makeRepo();
    function Inner() {
      const local = useLocalState();
      return <div data-count={local.comments.length} />;
    }
    const { container } = render(
      <RepositoryProvider repo={repo}>
        <Inner />
      </RepositoryProvider>,
    );
    const div = container.querySelector("div");
    expect(div?.getAttribute("data-count")).toBe("0");
  });
});
