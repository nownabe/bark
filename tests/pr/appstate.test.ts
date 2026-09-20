import { describe, expect, test } from "bun:test";
import { deriveAppState, parseSuggestion } from "../../lib/pr/appstate";
import type {
  Comment,
  FileContent,
  LocalState,
  PullRequest,
  RemoteState,
  Thread,
  User,
} from "../../lib/pr/types";
import { emptyState } from "../../lib/pr/types";

const author = { login: "alice" };

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    state: "synced",
    remoteId: 1,
    threadId: "t1",
    body: "body",
    author,
    path: "README.md",
    anchor: {
      sha: "old-sha",
      range: { sl: 1, sc: 1, el: 1, ec: 6 },
      quote: "hello",
    },
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    state: "synced",
    remoteThreadId: "PRT",
    resolved: false,
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
    headSha: "head",
    headRef: "topic",
    baseRef: "main",
    state: "open",
    draft: false,
    merged: false,
    author,
    ...overrides,
  };
}

function fileContent(sha: string, path: string, source: string): FileContent {
  return { sha, path, source };
}

function localState(overrides: Partial<LocalState> = {}): LocalState {
  return { ...emptyState(), ...overrides };
}

function remoteState(overrides: Partial<RemoteState> = {}): RemoteState {
  return { ...emptyState(), ...overrides };
}

describe("appstate — parseSuggestion", () => {
  test("plain text is comment", () => {
    expect(parseSuggestion("Looks good!")).toEqual({ kind: "comment" });
  });

  test("body with a suggestion fence is suggestion + replacement", () => {
    const body = "Try this:\n```suggestion\nnew line\n```";
    expect(parseSuggestion(body)).toEqual({
      kind: "suggestion",
      replacement: "new line",
    });
  });

  test("multi-line suggestion replacement is preserved", () => {
    const body = "```suggestion\nline a\nline b\n```";
    expect(parseSuggestion(body)).toEqual({
      kind: "suggestion",
      replacement: "line a\nline b",
    });
  });

  test("empty suggestion fence yields an empty replacement", () => {
    const body = "```suggestion\n```";
    expect(parseSuggestion(body)).toMatchObject({ kind: "suggestion" });
  });

  test("only the first suggestion fence is parsed", () => {
    const body = "```suggestion\nfirst\n```\nand\n```suggestion\nsecond\n```";
    expect(parseSuggestion(body)).toEqual({
      kind: "suggestion",
      replacement: "first",
    });
  });

  test("a longer outer fence keeps an inner ``` fence intact (issue #195)", () => {
    const inner = "```js\nconst x = 1;\n```";
    const body = "Try:\n````suggestion\n" + inner + "\n````";
    expect(parseSuggestion(body)).toEqual({
      kind: "suggestion",
      replacement: inner,
    });
  });

  test("CRLF suggestion body round-trips (GitHub API line endings)", () => {
    const body = "Try this:\r\n```suggestion\r\nnew line\r\n```";
    expect(parseSuggestion(body)).toEqual({
      kind: "suggestion",
      replacement: "new line",
    });
  });
});

describe("appstate — deriveAppState: role", () => {
  test("role is null until both viewer and pullRequest are loaded", () => {
    const out = deriveAppState(localState(), remoteState());
    expect(out.role).toBeNull();
  });

  test("viewer matching PR author → role: author", () => {
    const viewer: User = { login: "alice" };
    const out = deriveAppState(
      localState(),
      remoteState({ viewer, pullRequest: pr({ author: { login: "ALICE" } }) }),
    );
    expect(out.role).toBe("author");
  });

  test("viewer different from PR author → role: reviewer", () => {
    const out = deriveAppState(
      localState(),
      remoteState({
        viewer: { login: "bob" },
        pullRequest: pr({ author: { login: "alice" } }),
      }),
    );
    expect(out.role).toBe("reviewer");
  });
});

describe("appstate — deriveAppState: CommentView", () => {
  test("a draft Comment is marked isMyDraft", () => {
    const c = comment({ state: "draft" });
    const out = deriveAppState(localState({ comments: [c] }), remoteState({ pullRequest: pr() }));
    expect(out.commentViews.get("c1")?.isMyDraft).toBe(true);
  });

  test("kind / replacement are derived from the body", () => {
    const c = comment({
      body: "Try:\n```suggestion\nfixed\n```",
    });
    const out = deriveAppState(localState({ comments: [c] }), remoteState({ pullRequest: pr() }));
    const view = out.commentViews.get("c1");
    expect(view?.kind).toBe("suggestion");
    expect(view?.replacement).toBe("fixed");
  });

  test("displayPosition is current when anchor.sha === headSha", () => {
    const c = comment({
      anchor: { sha: "head", range: { sl: 1, sc: 1, el: 1, ec: 6 }, quote: "hi" },
    });
    const out = deriveAppState(localState({ comments: [c] }), remoteState({ pullRequest: pr() }));
    expect(out.commentViews.get("c1")?.displayPosition.status).toBe("current");
  });

  test("displayPosition is outdated when oldSource is missing", () => {
    const c = comment({
      anchor: { sha: "older", range: { sl: 1, sc: 1, el: 1, ec: 6 }, quote: "x" },
    });
    const out = deriveAppState(localState({ comments: [c] }), remoteState({ pullRequest: pr() }));
    expect(out.commentViews.get("c1")?.displayPosition.status).toBe("outdated");
  });

  test("displayPosition is mapped when LCS traces the anchor and quote matches", () => {
    const oldS = "alpha\nbeta\ngamma";
    const newS = "alpha\nINSERTED\nbeta\ngamma";
    const c = comment({
      anchor: { sha: "old", range: { sl: 2, sc: 1, el: 2, ec: 5 }, quote: "beta" },
      path: "f.md",
    });
    const out = deriveAppState(
      localState({ comments: [c] }),
      remoteState({
        pullRequest: pr(),
        fileContents: [fileContent("head", "f.md", newS), fileContent("old", "f.md", oldS)],
      }),
    );
    const dp = out.commentViews.get("c1")?.displayPosition;
    expect(dp).toEqual({ status: "mapped", range: { sl: 3, sc: 1, el: 3, ec: 5 } });
  });

  test("displayPosition is outdated when no PullRequest is loaded yet", () => {
    const c = comment();
    const out = deriveAppState(localState({ comments: [c] }), remoteState());
    expect(out.commentViews.get("c1")?.displayPosition.status).toBe("outdated");
  });
});

describe("appstate — deriveAppState: threadGroups", () => {
  test("groups Comments by threadId", () => {
    const c1 = comment({ id: "c1", threadId: "t1" });
    const c2 = comment({ id: "c2", threadId: "t1" });
    const c3 = comment({ id: "c3", threadId: "t2" });
    const t1 = thread({ id: "t1" });
    const t2 = thread({ id: "t2" });
    const out = deriveAppState(
      localState({ comments: [c1, c2, c3], threads: [t1, t2] }),
      remoteState({ pullRequest: pr() }),
    );
    const ids = (id: string) =>
      out.threadGroups.find((g) => g.thread.id === id)?.comments.map((c) => c.comment.id);
    expect(ids("t1")).toEqual(["c1", "c2"]);
    expect(ids("t2")).toEqual(["c3"]);
  });

  test("a thread with no comments still appears (empty group)", () => {
    const t = thread({ id: "orphan" });
    const out = deriveAppState(localState({ threads: [t] }), remoteState({ pullRequest: pr() }));
    expect(out.threadGroups[0]).toMatchObject({
      thread: t,
      comments: [],
    });
  });

  test("comments whose threadId has no matching Thread surface in synthetic groups", () => {
    // Foreign review/issue comments arrive with a threadId that does not
    // match anything in LocalState.threads (the fetchThreads side uses a
    // GraphQL node id while toCommentFromReview synthesises a per-comment
    // id). Without a synthetic group they would be invisible in the UI.
    const foreignReview = comment({
      id: "foreign-review-42",
      threadId: "foreign-thread-review-42",
      path: "test.md",
      anchor: { sha: "", range: { sl: 5, sc: 1, el: 5, ec: 1 }, quote: "" },
    });
    const foreignIssue = comment({
      id: "foreign-issue-50",
      threadId: "foreign-thread-issue-50",
      path: "",
      anchor: { sha: "", range: { sl: 1, sc: 1, el: 1, ec: 1 }, quote: "" },
    });
    const out = deriveAppState(
      localState({ comments: [foreignReview, foreignIssue], threads: [] }),
      remoteState({ pullRequest: pr() }),
    );

    const findGroup = (tid: string) => out.threadGroups.find((g) => g.thread.id === tid);
    expect(findGroup("foreign-thread-review-42")?.thread.state).toBe("synced");
    expect(findGroup("foreign-thread-review-42")?.comments.map((c) => c.comment.id)).toEqual([
      "foreign-review-42",
    ]);
    expect(findGroup("foreign-thread-issue-50")?.comments.map((c) => c.comment.id)).toEqual([
      "foreign-issue-50",
    ]);
  });
});

describe("appstate — deriveAppState: currentFiles", () => {
  test("surfaces head-sha FileContents deduped and sorted by path", () => {
    const out = deriveAppState(
      localState(),
      remoteState({
        pullRequest: pr({ headSha: "head" }),
        fileContents: [
          fileContent("head", "z.md", "Z"),
          fileContent("old", "skip.md", "old"),
          fileContent("head", "a.md", "A"),
          // Duplicate (sha, path) keeps only the first seen entry.
          fileContent("head", "a.md", "A-dupe"),
        ],
      }),
    );
    expect(out.currentFiles.map((f) => f.path)).toEqual(["a.md", "z.md"]);
    expect(out.currentFiles.find((f) => f.path === "a.md")?.source).toBe("A");
  });

  test("is empty when no PullRequest is loaded yet", () => {
    const out = deriveAppState(
      localState(),
      remoteState({
        fileContents: [fileContent("anything", "a.md", "A")],
      }),
    );
    expect(out.currentFiles).toEqual([]);
  });
});

describe("appstate — deriveAppState: inDiff derives from RemoteState.changedFiles (ADR 0002 §4)", () => {
  // Patch with RIGHT-side commentable lines 1-3 on README.md.
  const PATCH = "@@ -1,3 +1,3 @@\n line1\n-old\n+new\n line3";

  test("a comment anchored inside a changed file's diff hunk is inDiff", () => {
    const c = comment({
      anchor: { sha: "head", range: { sl: 2, sc: 1, el: 2, ec: 4 }, quote: "x" },
    });
    const out = deriveAppState(
      localState({ comments: [c] }),
      remoteState({
        pullRequest: pr(),
        changedFiles: [{ path: "README.md", status: "modified", patch: PATCH }],
      }),
    );
    expect(out.commentViews.get("c1")?.inDiff).toBe(true);
  });

  test("a comment outside every hunk — or with no changedFiles at all — is not inDiff", () => {
    const c = comment({
      anchor: { sha: "head", range: { sl: 99, sc: 1, el: 99, ec: 4 }, quote: "x" },
    });
    const withFiles = deriveAppState(
      localState({ comments: [c] }),
      remoteState({
        pullRequest: pr(),
        changedFiles: [{ path: "README.md", status: "modified", patch: PATCH }],
      }),
    );
    expect(withFiles.commentViews.get("c1")?.inDiff).toBe(false);

    const noFiles = deriveAppState(localState({ comments: [c] }), remoteState());
    expect(noFiles.commentViews.get("c1")?.inDiff).toBe(false);
  });
});

describe("appstate — deriveAppState: changedMarkdownFiles", () => {
  test("keeps only non-removed .md entries (case-insensitive), preserving API order", () => {
    const out = deriveAppState(
      localState(),
      remoteState({
        changedFiles: [
          { path: "z-guide.md", status: "modified", patch: "@@ z" },
          { path: "src/app.ts", status: "modified", patch: "@@ ts" },
          { path: "GONE.md", status: "removed", patch: "@@ gone" },
          { path: "README.MD", status: "added", patch: "@@ readme" },
        ],
      }),
    );
    expect(out.changedMarkdownFiles.map((f) => f.path)).toEqual(["z-guide.md", "README.MD"]);
    // The patch rides along — the UI derives in-diff ranges from it.
    expect(out.changedMarkdownFiles[0]?.patch).toBe("@@ z");
  });

  test("accepts .markdown and .mdx alongside .md, case-insensitively", () => {
    const out = deriveAppState(
      localState(),
      remoteState({
        changedFiles: [
          { path: "notes.markdown", status: "modified", patch: "@@ a" },
          { path: "docs/Guide.MDX", status: "added", patch: "@@ b" },
          { path: "not-markdown.mdxx", status: "modified", patch: "@@ c" },
          { path: "readme.md", status: "modified", patch: "@@ d" },
        ],
      }),
    );
    expect(out.changedMarkdownFiles.map((f) => f.path)).toEqual([
      "notes.markdown",
      "docs/Guide.MDX",
      "readme.md",
    ]);
  });

  test("is empty when the remote snapshot has no changedFiles yet", () => {
    const out = deriveAppState(localState(), remoteState());
    expect(out.changedMarkdownFiles).toEqual([]);
  });
});
