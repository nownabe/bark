import { describe, expect, test } from "bun:test";
import {
  commentsContainCids,
  normalizeComments,
  reloadCommentsUntil,
  type ExistingComment,
} from "../lib/comments";
import { embedMetadata, type CommentMetadata } from "../lib/metadata";
import type { RawIssueComment, RawReviewComment } from "../lib/github";

const meta: CommentMetadata = {
  cid: "c1",
  path: "docs/spec.md",
  range: { sl: 3, sc: 1, el: 3, ec: 9 },
  quote: "Hello --",
  sha: "deadbee",
  thread: "t1",
};

describe("normalizeComments", () => {
  const reviews: RawReviewComment[] = [
    {
      id: 1,
      body: embedMetadata("fix here", meta),
      path: "docs/spec.md",
      line: 3,
      user: { login: "alice" },
    },
    { id: 2, body: "plain review comment", path: "docs/spec.md", line: 5, user: { login: "bob" } },
  ];
  const issues: RawIssueComment[] = [{ id: 3, body: "an issue comment", user: { login: "carol" } }];
  const result = normalizeComments(reviews, issues);

  test("normalizes review and issue comments", () => {
    expect(result).toHaveLength(3);
  });

  test("tool-authored comment restores anchor + visible body", () => {
    const tool = result.find((c) => c.id === 1)!;
    expect(tool.meta).toEqual(meta);
    expect(tool.body).toBe("fix here");
    expect(tool.author).toBe("alice");
  });

  test("foreign comment degrades to path/line", () => {
    const foreign = result.find((c) => c.id === 2)!;
    expect(foreign.meta).toBeNull();
    expect(foreign.path).toBe("docs/spec.md");
    expect(foreign.line).toBe(5);
  });

  test("issue comment has source=issue", () => {
    const issue = result.find((c) => c.id === 3)!;
    expect(issue.source).toBe("issue");
    expect(issue.meta).toBeNull();
  });
});

function withCid(cid: string): ExistingComment {
  return { id: 0, source: "review", author: "me", body: "b", meta: { ...meta, cid } };
}

describe("commentsContainCids", () => {
  test("empty expected set is trivially present", () => {
    expect(commentsContainCids([], [])).toBe(true);
    expect(commentsContainCids([withCid("a")], [])).toBe(true);
  });

  test("true only when every cid appears in the comments' metadata", () => {
    const comments = [withCid("a"), withCid("b")];
    expect(commentsContainCids(comments, ["a", "b"])).toBe(true);
    expect(commentsContainCids(comments, ["a", "c"])).toBe(false);
  });

  test("foreign comments (no meta) never satisfy a cid", () => {
    expect(commentsContainCids([{ ...withCid("x"), meta: null }], ["x"])).toBe(false);
  });
});

describe("reloadCommentsUntil", () => {
  const noSleep = () => Promise.resolve();

  test("returns the first fetch without sleeping when all cids are present", async () => {
    let fetches = 0;
    let sleeps = 0;
    const result = await reloadCommentsUntil(
      () => {
        fetches++;
        return Promise.resolve([withCid("a")]);
      },
      ["a"],
      {
        sleep: () => {
          sleeps++;
          return Promise.resolve();
        },
      },
    );
    expect(result).toHaveLength(1);
    expect(fetches).toBe(1);
    expect(sleeps).toBe(0);
  });

  test("retries past a stale read until the just-submitted cid appears", async () => {
    // Mirrors GitHub read-after-write lag: the first GET omits the new comment.
    const responses = [[], [withCid("a")]];
    let i = 0;
    const result = await reloadCommentsUntil(() => Promise.resolve(responses[i++]), ["a"], {
      sleep: noSleep,
    });
    expect(commentsContainCids(result, ["a"])).toBe(true);
    expect(i).toBe(2);
  });

  test("gives up after attempts and returns the last (still-stale) result", async () => {
    let fetches = 0;
    const result = await reloadCommentsUntil(
      () => {
        fetches++;
        return Promise.resolve([]);
      },
      ["a"],
      { attempts: 3, sleep: noSleep },
    );
    expect(result).toEqual([]);
    expect(fetches).toBe(3);
  });
});
