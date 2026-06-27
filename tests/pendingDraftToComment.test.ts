import { describe, expect, test } from "bun:test";
import { pendingDraftToComment } from "../entrypoints/review/adapters/pendingDraftToComment";
import type { PendingDraft } from "../lib/drafts";

function makeDraft(overrides: Partial<PendingDraft> = {}): PendingDraft {
  return {
    cid: "draft-1",
    path: "f.md",
    inDiff: true,
    range: { sl: 5, sc: 1, el: 5, ec: 10 },
    quote: "hello",
    sha: "abc",
    thread: "t-1",
    body: "looks off",
    kind: "comment",
    ...overrides,
  };
}

describe("pendingDraftToComment", () => {
  test("maps every field a draft Comment needs", () => {
    const out = pendingDraftToComment(makeDraft(), "alice");
    expect(out).toEqual({
      id: "draft-1",
      state: "draft",
      threadId: "t-1",
      parentLocalId: undefined,
      body: "looks off",
      author: { login: "alice" },
      path: "f.md",
      anchor: {
        sha: "abc",
        range: { sl: 5, sc: 1, el: 5, ec: 10 },
        quote: "hello",
      },
    });
  });

  test("threads parentLocalId through when supplied (used by replies)", () => {
    const out = pendingDraftToComment(makeDraft(), "alice", "root-c-1");
    expect(out.parentLocalId).toBe("root-c-1");
  });
});
