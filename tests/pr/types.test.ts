import { describe, expect, test } from "bun:test";
import { canResolveThread } from "../../lib/pr/types";
import type { Thread } from "../../lib/pr/types";

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
