// Author-mode Submit orchestration — keystone test for the call order and
// error semantics defined in the design doc:
//   comments → replies → commit (blob/tree/commit/updateRef) → resolves
// Errors stop the stage they originate in; later stages don't run. Resolve
// errors are non-fatal — collected and returned so the caller can surface them.
import { describe, expect, test } from "bun:test";
import { executeAuthorSubmit, type AuthorSubmitInput } from "../lib/authorSubmit";

type Call =
  | { method: "submitReview"; commitId: string | undefined; comments: unknown[] }
  | { method: "createIssueComment"; body: string }
  | { method: "replyToReviewComment"; inReplyTo: number; body: string }
  | { method: "createBlob"; content: string }
  | { method: "createTree"; baseTree: string; entries: unknown[] }
  | { method: "createCommit"; message: string; tree: string; parents: string[] }
  | { method: "updateRef"; branch: string; sha: string }
  | { method: "resolveReviewThread"; threadId: string };

interface MockSetup {
  blobSha?: (content: string) => string;
  treeSha?: string;
  commitSha?: string;
  failAt?: Call["method"];
  failResolveFor?: string[]; // threadIds whose resolve should throw
}

function makeMockClient(setup: MockSetup = {}) {
  const calls: Call[] = [];
  const maybeFail = (method: Call["method"]) => {
    if (setup.failAt === method) throw new Error(`${method} failed`);
  };
  const client = {
    async submitReview(_ref: unknown, input: { commitId?: string; comments: unknown[] }) {
      maybeFail("submitReview");
      calls.push({ method: "submitReview", commitId: input.commitId, comments: input.comments });
    },
    async createIssueComment(_ref: unknown, body: string) {
      maybeFail("createIssueComment");
      calls.push({ method: "createIssueComment", body });
    },
    async replyToReviewComment(_ref: unknown, inReplyTo: number, body: string) {
      maybeFail("replyToReviewComment");
      calls.push({ method: "replyToReviewComment", inReplyTo, body });
    },
    async createBlob(_ref: unknown, content: string) {
      maybeFail("createBlob");
      calls.push({ method: "createBlob", content });
      return setup.blobSha?.(content) ?? `blob-of:${content.slice(0, 10)}`;
    },
    async createTree(
      _ref: unknown,
      input: { baseTree: string; entries: { path: string; sha: string }[] },
    ) {
      maybeFail("createTree");
      calls.push({ method: "createTree", baseTree: input.baseTree, entries: input.entries });
      return setup.treeSha ?? "tree-sha";
    },
    async createCommit(_ref: unknown, input: { message: string; tree: string; parents: string[] }) {
      maybeFail("createCommit");
      calls.push({
        method: "createCommit",
        message: input.message,
        tree: input.tree,
        parents: input.parents,
      });
      return setup.commitSha ?? "commit-sha";
    },
    async updateRef(_ref: unknown, branch: string, sha: string) {
      maybeFail("updateRef");
      calls.push({ method: "updateRef", branch, sha });
    },
    async resolveReviewThread(threadId: string) {
      // Record the attempt first so failed resolves still show up in the call
      // log — useful for asserting that the orchestrator keeps going past a
      // resolve failure instead of bailing on the whole stage.
      calls.push({ method: "resolveReviewThread", threadId });
      if (setup.failResolveFor?.includes(threadId)) {
        throw new Error(`resolve failed for ${threadId}`);
      }
      maybeFail("resolveReviewThread");
    },
  };
  return { client, calls };
}

const ref = { owner: "o", repo: "r", number: 1 };

function baseInput(over: Partial<AuthorSubmitInput> = {}): AuthorSubmitInput {
  return {
    client: makeMockClient().client as never,
    ref,
    branch: "feat",
    baseSha: "head-sha",
    reviewComments: [],
    issueBodies: [],
    replies: [],
    files: [],
    commitMessage: "docs: update via Bark",
    acceptedThreads: [],
    ...over,
  };
}

function acceptedThread(over: Partial<AuthorSubmitInput["acceptedThreads"][number]> = {}) {
  return {
    rootCommentId: 1,
    threadNodeId: "PRRT_1",
    eventBody: (_newHeadSha: string) => "<!-- bark:meta {} -->\nResolved via Bark.",
    ...over,
  };
}

describe("executeAuthorSubmit — happy path call order", () => {
  test("comments → replies → blobs → tree → commit → updateRef → resolves", async () => {
    const { client, calls } = makeMockClient();
    const result = await executeAuthorSubmit({
      ...baseInput(),
      client: client as never,
      reviewComments: [{ path: "a.md", side: "RIGHT", line: 3, body: "comment-a" }],
      issueBodies: ["outside the diff"],
      replies: [{ rootCommentId: 99, body: "reply!" }],
      files: [
        { path: "a.md", content: "edited A" },
        { path: "docs/b.md", content: "edited B" },
      ],
      acceptedThreads: [
        acceptedThread({ rootCommentId: 11, threadNodeId: "PRRT_1" }),
        acceptedThread({ rootCommentId: 22, threadNodeId: "PRRT_2" }),
      ],
    });

    // Each accepted thread gets a Bark event-metadata reply BEFORE the GraphQL
    // resolve, so the local sidebar still sees the thread as resolved after
    // the dismissed map is cleared (the local UI tracks resolution from the
    // embedded event comment, not from GitHub's GraphQL isResolved).
    const order = calls.map((c) => c.method);
    expect(order).toEqual([
      "submitReview",
      "createIssueComment",
      "replyToReviewComment", // user reply draft (Stage 2)
      "createBlob",
      "createBlob",
      "createTree",
      "createCommit",
      "updateRef",
      // per-thread: event reply -> graphql resolve, interleaved
      "replyToReviewComment",
      "resolveReviewThread",
      "replyToReviewComment",
      "resolveReviewThread",
    ]);

    // submitReview carries the pre-commit head sha and the in-diff drafts
    expect(calls[0]).toMatchObject({
      method: "submitReview",
      commitId: "head-sha",
    });
    expect((calls[0] as { comments: unknown[] }).comments).toHaveLength(1);

    // createTree has base_tree = pre-commit head and one entry per file
    expect(calls[5].method).toBe("createTree");
    expect((calls[5] as { baseTree: string; entries: unknown[] }).baseTree).toBe("head-sha");
    expect((calls[5] as { entries: unknown[] }).entries).toHaveLength(2);

    // createCommit parents = [old head]
    expect((calls[6] as { parents: string[] }).parents).toEqual(["head-sha"]);
    expect((calls[6] as { message: string }).message).toBe("docs: update via Bark");

    // updateRef pushes the new commit on the branch
    expect(calls[7]).toMatchObject({
      method: "updateRef",
      branch: "feat",
      sha: "commit-sha",
    });

    // resolved both threads, returns the new head
    expect(result.newHeadSha).toBe("commit-sha");
    expect(result.resolveErrors).toEqual([]);
  });

  test("returns baseSha when no files were committed", async () => {
    const { client, calls } = makeMockClient();
    const result = await executeAuthorSubmit({
      ...baseInput(),
      client: client as never,
      reviewComments: [{ path: "a.md", side: "RIGHT", line: 1, body: "x" }],
    });
    expect(calls.map((c) => c.method)).toEqual(["submitReview"]);
    expect(result.newHeadSha).toBe("head-sha");
  });
});

describe("executeAuthorSubmit — skips empty stages", () => {
  test("comments-only: no Git Data API calls", async () => {
    const { client, calls } = makeMockClient();
    await executeAuthorSubmit({
      ...baseInput(),
      client: client as never,
      reviewComments: [{ path: "a.md", side: "RIGHT", line: 1, body: "hi" }],
    });
    expect(calls.map((c) => c.method)).toEqual(["submitReview"]);
  });

  test("edits-only: no comment/reply/resolve calls", async () => {
    const { client, calls } = makeMockClient();
    await executeAuthorSubmit({
      ...baseInput(),
      client: client as never,
      files: [{ path: "a.md", content: "edited" }],
    });
    expect(calls.map((c) => c.method)).toEqual([
      "createBlob",
      "createTree",
      "createCommit",
      "updateRef",
    ]);
  });

  test("accepted threads with no edits: skip commit, still post resolve-event + GraphQL resolve", async () => {
    // The author may accept a suggestion that's effectively a no-op (source === base),
    // e.g. they accepted and undid by editing. Resolves still run.
    const { client, calls } = makeMockClient();
    await executeAuthorSubmit({
      ...baseInput(),
      client: client as never,
      acceptedThreads: [acceptedThread({ rootCommentId: 7, threadNodeId: "PRRT_X" })],
    });
    expect(calls.map((c) => c.method)).toEqual(["replyToReviewComment", "resolveReviewThread"]);
    expect((calls[0] as { inReplyTo: number }).inReplyTo).toBe(7);
    expect((calls[1] as { threadId: string }).threadId).toBe("PRRT_X");
  });

  test("empty input is a no-op", async () => {
    const { client, calls } = makeMockClient();
    const result = await executeAuthorSubmit({ ...baseInput(), client: client as never });
    expect(calls).toHaveLength(0);
    expect(result.newHeadSha).toBe("head-sha");
  });
});

describe("executeAuthorSubmit — error semantics", () => {
  test("submitReview failure: nothing else runs", async () => {
    const { client, calls } = makeMockClient({ failAt: "submitReview" });
    const err = await executeAuthorSubmit({
      ...baseInput(),
      client: client as never,
      reviewComments: [{ path: "a.md", side: "RIGHT", line: 1, body: "x" }],
      files: [{ path: "a.md", content: "edited" }],
      acceptedThreads: [acceptedThread()],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0); // failed before recording
  });

  test("updateRef failure: comments already posted, but no resolves; reports the stage", async () => {
    const { client, calls } = makeMockClient({ failAt: "updateRef" });
    const err = (await executeAuthorSubmit({
      ...baseInput(),
      client: client as never,
      reviewComments: [{ path: "a.md", side: "RIGHT", line: 1, body: "x" }],
      files: [{ path: "a.md", content: "edited" }],
      acceptedThreads: [acceptedThread()],
    }).catch((e) => e)) as Error & { stage?: string };
    expect(err.message).toMatch(/updateRef/);
    expect(err.stage).toBe("commit");
    // submitReview, createBlob, createTree, createCommit ran; updateRef threw → no resolve.
    expect(calls.map((c) => c.method)).toEqual([
      "submitReview",
      "createBlob",
      "createTree",
      "createCommit",
    ]);
  });

  test("resolve failures are non-fatal and surface in resolveErrors", async () => {
    const { client, calls } = makeMockClient({ failResolveFor: ["t2"] });
    const result = await executeAuthorSubmit({
      ...baseInput(),
      client: client as never,
      files: [{ path: "a.md", content: "edited" }],
      acceptedThreads: [
        acceptedThread({ rootCommentId: 1, threadNodeId: "t1" }),
        acceptedThread({ rootCommentId: 2, threadNodeId: "t2" }),
        acceptedThread({ rootCommentId: 3, threadNodeId: "t3" }),
      ],
    });
    expect(result.resolveErrors).toHaveLength(1);
    expect(result.resolveErrors[0].threadId).toBe("t2");
    // All three event replies AND all three GraphQL resolves were attempted;
    // only t2's GraphQL resolve failed, the others succeeded.
    expect(
      calls
        .filter((c) => c.method === "resolveReviewThread")
        .map((c) => (c as { threadId: string }).threadId),
    ).toEqual(["t1", "t2", "t3"]);
    expect(calls.filter((c) => c.method === "replyToReviewComment")).toHaveLength(3);
  });

  test("event-reply failure for a thread skips that thread's GraphQL resolve but keeps going", async () => {
    // If the metadata event reply fails, doing the GraphQL resolve would leave
    // the local UI re-emerging (the original bug) for that thread. Better to
    // skip the GraphQL resolve and surface an error, then keep going on the
    // next thread so other accepts still land.
    const { client, calls } = makeMockClient({ failAt: "replyToReviewComment" });
    const result = await executeAuthorSubmit({
      ...baseInput(),
      client: client as never,
      // Two threads — the first will fail its reply; the test asserts the
      // second is unaffected. (failAt is one-shot via maybeFail which always
      // throws on the configured method, so both threads' replies fail. That
      // is the strictest assertion we can make with this mock without adding
      // a per-thread fail toggle; the per-thread isolation is exercised by
      // the resolveErrors length below.)
      acceptedThreads: [
        acceptedThread({ rootCommentId: 1, threadNodeId: "t1" }),
        acceptedThread({ rootCommentId: 2, threadNodeId: "t2" }),
      ],
    });
    // No GraphQL resolves landed (event reply failed each time)
    expect(calls.filter((c) => c.method === "resolveReviewThread")).toHaveLength(0);
    expect(result.resolveErrors).toHaveLength(2);
  });
});

describe("executeAuthorSubmit — eventBody composition", () => {
  test("eventBody is invoked with the new commit sha after the commit lands", async () => {
    // The accept-suggestion reply should reference the commit that applied
    // the change — so eventBody is a function of the new head sha, called
    // after the commit step. With a commit, that sha is the new commit.
    const { client, calls } = makeMockClient({ commitSha: "new-commit-sha" });
    const seen: string[] = [];
    await executeAuthorSubmit({
      ...baseInput(),
      client: client as never,
      files: [{ path: "a.md", content: "edited" }],
      acceptedThreads: [
        {
          rootCommentId: 7,
          threadNodeId: "PRRT_X",
          eventBody: (sha) => {
            seen.push(sha);
            return `Applied via Bark in ${sha}.`;
          },
        },
      ],
    });
    expect(seen).toEqual(["new-commit-sha"]);
    const reply = calls.find((c) => c.method === "replyToReviewComment") as { body: string };
    expect(reply.body).toBe("Applied via Bark in new-commit-sha.");
  });

  test("eventBody receives the baseSha when no files were committed", async () => {
    // No-op accept (suggestion source === base): eventBody still runs, but
    // there's no new commit, so the caller can detect that and fall back.
    const { client, calls } = makeMockClient();
    const seen: string[] = [];
    await executeAuthorSubmit({
      ...baseInput(),
      client: client as never,
      acceptedThreads: [
        {
          rootCommentId: 7,
          threadNodeId: "PRRT_X",
          eventBody: (sha) => {
            seen.push(sha);
            return `(no-op, ${sha})`;
          },
        },
      ],
    });
    expect(seen).toEqual(["head-sha"]);
    const reply = calls.find((c) => c.method === "replyToReviewComment") as { body: string };
    expect(reply.body).toBe("(no-op, head-sha)");
  });
});

describe("executeAuthorSubmit — multi-file commit details", () => {
  test("tree entries are sorted by path and use the new blob shas", async () => {
    const { client, calls } = makeMockClient({
      blobSha: (c) => `blob-${c}`,
    });
    await executeAuthorSubmit({
      ...baseInput(),
      client: client as never,
      files: [
        { path: "docs/b.md", content: "B" },
        { path: "a.md", content: "A" },
      ],
    });
    const treeCall = calls.find((c) => c.method === "createTree") as {
      entries: { path: string; mode: string; type: string; sha: string }[];
    };
    expect(treeCall.entries).toEqual([
      { path: "a.md", mode: "100644", type: "blob", sha: "blob-A" },
      { path: "docs/b.md", mode: "100644", type: "blob", sha: "blob-B" },
    ]);
  });
});
