import { describe, expect, test } from "bun:test";
import { deriveCommentStatuses } from "../../lib/pr/commentStatus";
import type { DisplayPosition } from "../../lib/pr/reanchor";
import type { Anchor, Comment, PrCommit } from "../../lib/pr/types";

const author = { login: "alice" };

function anchor(overrides: Partial<Anchor> = {}): Anchor {
  return {
    sha: "sha0",
    range: { sl: 2, sc: 1, el: 2, ec: 6 },
    quote: "hello",
    ...overrides,
  };
}

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    state: "synced",
    threadId: "t1",
    body: "b",
    author,
    path: "f.md",
    anchor: anchor(),
    ...overrides,
  };
}

function commit(sha: string, committedAt: string): PrCommit {
  return { sha, message: "m", author, committedAt, parents: [] };
}

// Convenience builder for the input bundle with sensible defaults.
function inputs(overrides: {
  resolved?: Set<string>;
  displayPositions?: Record<string, DisplayPosition>;
  commits?: PrCommit[];
  files?: Record<string, string>; // key: `${sha}\0${path}`
}) {
  return {
    resolvedByThreadId: (id: string) => overrides.resolved?.has(id) ?? false,
    displayPositionOf: (id: string) => overrides.displayPositions?.[id],
    commits: overrides.commits ?? [],
    fileSourceAt: (sha: string, path: string) => overrides.files?.[`${sha}\0${path}`],
  };
}

describe("commentStatus — deriveCommentStatuses", () => {
  test("resolved wins over everything (even an outdated display position)", () => {
    const c = comment({ threadId: "t-resolved" });
    const out = deriveCommentStatuses([c], {
      ...inputs({
        resolved: new Set(["t-resolved"]),
        displayPositions: { c1: { status: "outdated" } },
      }),
    });
    expect(out.get("c1")).toEqual({ status: "resolved" });
  });

  test("outdated comes from the display position when not resolved", () => {
    const c = comment();
    const out = deriveCommentStatuses([c], {
      ...inputs({ displayPositions: { c1: { status: "outdated" } } }),
    });
    expect(out.get("c1")).toEqual({ status: "outdated" });
  });

  test("addressed: first commit after the anchor sha where the region stops surviving", () => {
    const c = comment({ anchor: anchor({ sha: "sha0" }) });
    const src0 = "top\nhello\nbottom";
    const src1 = "top\nhello\nbottom"; // unchanged in c1
    const src2 = "top\nCHANGED\nbottom"; // hello edited away in c2
    const out = deriveCommentStatuses([c], {
      ...inputs({
        displayPositions: { c1: { status: "mapped", range: c.anchor.range } },
        commits: [
          commit("sha0", "2026-07-01T00:00:00Z"),
          commit("sha1", "2026-07-01T01:00:00Z"),
          commit("sha2", "2026-07-01T02:00:00Z"),
        ],
        files: {
          [`sha0\0f.md`]: src0,
          [`sha1\0f.md`]: src1,
          [`sha2\0f.md`]: src2,
        },
      }),
    });
    expect(out.get("c1")).toEqual({ status: "addressed", addressedBySha: "sha2" });
  });

  test("open when the region survives unchanged through every later commit", () => {
    const c = comment({ anchor: anchor({ sha: "sha0" }) });
    const src = "top\nhello\nbottom";
    const out = deriveCommentStatuses([c], {
      ...inputs({
        displayPositions: { c1: { status: "mapped", range: c.anchor.range } },
        commits: [commit("sha0", "2026-07-01T00:00:00Z"), commit("sha1", "2026-07-01T01:00:00Z")],
        files: { [`sha0\0f.md`]: src, [`sha1\0f.md`]: src },
      }),
    });
    expect(out.get("c1")).toEqual({ status: "open" });
  });

  test("a missing mid-commit FileContent is skipped, not treated as addressed", () => {
    const c = comment({ anchor: anchor({ sha: "sha0" }) });
    const src = "top\nhello\nbottom";
    const out = deriveCommentStatuses([c], {
      ...inputs({
        displayPositions: { c1: { status: "mapped", range: c.anchor.range } },
        commits: [
          commit("sha0", "2026-07-01T00:00:00Z"),
          commit("sha1", "2026-07-01T01:00:00Z"), // no FileContent fetched
        ],
        // sha1/f.md deliberately absent
        files: { [`sha0\0f.md`]: src },
      }),
    });
    expect(out.get("c1")).toEqual({ status: "open" });
  });

  test("no addressed check when the anchor source itself is missing (outdated already)", () => {
    const c = comment({ anchor: anchor({ sha: "sha0" }) });
    const out = deriveCommentStatuses([c], {
      ...inputs({
        displayPositions: { c1: { status: "outdated" } },
        commits: [commit("sha1", "2026-07-01T01:00:00Z")],
        files: {},
      }),
    });
    expect(out.get("c1")).toEqual({ status: "outdated" });
  });
});
