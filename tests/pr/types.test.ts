import { describe, expect, test } from "bun:test";
import { canResolveThread, normalizeAnchor } from "../../lib/pr/types";
import type { Anchor, Thread } from "../../lib/pr/types";

function thread(over: Partial<Thread> = {}): Thread {
  return { id: "t1", state: "synced", resolved: false, ...over };
}

describe("canResolveThread (issue #274)", () => {
  test("true for a remote thread the viewer may toggle", () => {
    expect(canResolveThread(thread({ remoteThreadId: "PRT_1", viewerCanResolve: true }))).toBe(
      true,
    );
    expect(canResolveThread(thread({ remoteIssueCommentId: 501, viewerCanResolve: true }))).toBe(
      true,
    );
  });

  test("false when GitHub would refuse the viewer", () => {
    expect(canResolveThread(thread({ remoteThreadId: "PRT_1", viewerCanResolve: false }))).toBe(
      false,
    );
  });

  test("false when the permission is unknown", () => {
    expect(canResolveThread(thread({ remoteThreadId: "PRT_1" }))).toBe(false);
  });

  test("false for a draft with no remote identity, however permissive the flag", () => {
    expect(canResolveThread(thread({ state: "draft", viewerCanResolve: true }))).toBe(false);
  });
});

function anchor(overrides: Partial<Anchor> = {}): Anchor {
  return {
    sha: "old",
    range: { sl: 3, sc: 1, el: 3, ec: 1 },
    quote: "alpha beta",
    ...overrides,
  };
}

describe("normalizeAnchor (issue #276)", () => {
  test("a legacy single-line anchor gets the end column its quote implies", () => {
    expect(normalizeAnchor(anchor()).range).toEqual({ sl: 3, sc: 1, el: 3, ec: 11 });
  });

  test("a legacy multi-line anchor's end column comes from the quote's last line", () => {
    const a = anchor({ range: { sl: 2, sc: 1, el: 3, ec: 1 }, quote: "ab\ncde" });
    expect(normalizeAnchor(a).range).toEqual({ sl: 2, sc: 1, el: 3, ec: 4 });
  });

  test("an anchor already following the rule is returned untouched", () => {
    const a = anchor({ range: { sl: 3, sc: 1, el: 3, ec: 11 } });
    expect(normalizeAnchor(a)).toBe(a);
  });

  test("an empty quote keeps its zero-width range", () => {
    const a = anchor({ quote: "" });
    expect(normalizeAnchor(a)).toBe(a);
  });
});
