import { describe, expect, test } from "bun:test";
import { normalizeComments } from "../lib/comments";
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
