import { beforeEach, describe, expect, mock, test } from "bun:test";

// Last-seen SHA storage is a thin wrapper over chrome.storage.local; back it
// with an in-memory store so the read/write/consume cycle can be exercised
// without the `browser` global (mirrors tests/drafts.test.ts).
const store: Record<string, unknown> = {};
mock.module("wxt/browser", () => ({
  browser: {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        },
        remove: async (key: string) => {
          delete store[key];
        },
      },
    },
  },
}));

const { readLastSeen, writeLastSeen, consumeAndAdvanceBaseline } = await import("../lib/lastSeen");

const ref = { owner: "o", repo: "r", number: 1 };

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe("readLastSeen / writeLastSeen", () => {
  test("read returns null before anything is stored", async () => {
    expect(await readLastSeen(ref)).toBeNull();
  });

  test("write then read round-trips sha and stamps seenAt", async () => {
    await writeLastSeen(ref, "sha1");
    const got = await readLastSeen(ref);
    expect(got?.sha).toBe("sha1");
    expect(typeof got?.seenAt).toBe("number");
  });
});

describe("consumeAndAdvanceBaseline", () => {
  test("first view returns null and records the head sha", async () => {
    expect(await consumeAndAdvanceBaseline(ref, "head1")).toBeNull();
    // The head is now recorded as last-seen for the next visit.
    expect((await readLastSeen(ref))?.sha).toBe("head1");
  });

  test("second view with advanced head returns the prior sha and stores the new head", async () => {
    await consumeAndAdvanceBaseline(ref, "head1"); // first view records head1
    const baseline = await consumeAndAdvanceBaseline(ref, "head2");
    expect(baseline).toBe("head1"); // the previously stored sha is captured before overwrite
    expect((await readLastSeen(ref))?.sha).toBe("head2");
  });

  test("head unchanged returns the same sha without churn", async () => {
    await writeLastSeen(ref, "head1");
    const before = await readLastSeen(ref);
    const baseline = await consumeAndAdvanceBaseline(ref, "head1");
    expect(baseline).toBe("head1"); // baseline === head → caller treats as no redline
    const after = await readLastSeen(ref);
    // Still head1; seenAt not bumped (no write when nothing advanced).
    expect(after?.sha).toBe("head1");
    expect(after?.seenAt).toBe(before?.seenAt);
  });

  test("keys are PR-scoped: two PRs do not collide", async () => {
    const refA = { owner: "o", repo: "r", number: 1 };
    const refB = { owner: "o", repo: "r", number: 2 };
    await consumeAndAdvanceBaseline(refA, "a1");
    await consumeAndAdvanceBaseline(refB, "b1");
    expect(await consumeAndAdvanceBaseline(refA, "a2")).toBe("a1");
    expect(await consumeAndAdvanceBaseline(refB, "b2")).toBe("b1");
  });
});
