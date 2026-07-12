import { describe, expect, test } from "bun:test";
import { deriveRounds } from "../../lib/pr/rounds";
import type { PrCommit, PrReview } from "../../lib/pr/types";

const author = { login: "alice" };

function commit(overrides: Partial<PrCommit> = {}): PrCommit {
  return {
    sha: "c0",
    message: "m",
    author,
    committedAt: "2026-07-01T00:00:00Z",
    parents: [],
    ...overrides,
  };
}

function review(overrides: Partial<PrReview> = {}): PrReview {
  return {
    id: 1,
    author,
    state: "COMMENTED",
    submittedAt: "2026-07-01T00:00:00Z",
    commitId: "c0",
    ...overrides,
  };
}

describe("rounds — deriveRounds", () => {
  test("empty commits and reviews → empty timeline", () => {
    const out = deriveRounds([], []);
    expect(out.rounds).toEqual([]);
    expect(out.entries).toEqual([]);
  });

  test("a single review becomes one round with its commit as baseSha", () => {
    const r = review({ id: 1, commitId: "c1", submittedAt: "2026-07-01T10:00:00Z" });
    const c = commit({ sha: "c1", committedAt: "2026-07-01T09:00:00Z" });
    const out = deriveRounds([c], [r]);
    expect(out.rounds).toHaveLength(1);
    expect(out.rounds[0]).toMatchObject({
      index: 0,
      baseSha: "c1",
      reviews: [r],
      addressingCommits: [],
      orphaned: false,
    });
  });

  test("two reviewers on the same commit collapse into one round", () => {
    const r1 = review({ id: 1, commitId: "c1", submittedAt: "2026-07-01T10:00:00Z" });
    const r2 = review({
      id: 2,
      author: { login: "bob" },
      commitId: "c1",
      submittedAt: "2026-07-01T11:00:00Z",
    });
    const out = deriveRounds([commit({ sha: "c1" })], [r2, r1]);
    expect(out.rounds).toHaveLength(1);
    // oldest-first inside the round
    expect(out.rounds[0]?.reviews.map((r) => r.id)).toEqual([1, 2]);
  });

  test("consecutive same-commit reviews group, a different commit starts a new round", () => {
    const r1 = review({ id: 1, commitId: "c1", submittedAt: "2026-07-01T01:00:00Z" });
    const r2 = review({ id: 2, commitId: "c1", submittedAt: "2026-07-01T02:00:00Z" });
    const r3 = review({ id: 3, commitId: "c2", submittedAt: "2026-07-01T05:00:00Z" });
    const commits = [
      commit({ sha: "c1", committedAt: "2026-07-01T00:30:00Z" }),
      commit({ sha: "c2", committedAt: "2026-07-01T03:00:00Z" }),
    ];
    const out = deriveRounds(commits, [r1, r2, r3]);
    expect(out.rounds.map((r) => r.baseSha)).toEqual(["c1", "c2"]);
    expect(out.rounds[0]?.reviews.map((r) => r.id)).toEqual([1, 2]);
    expect(out.rounds[1]?.reviews.map((r) => r.id)).toEqual([3]);
  });

  test("addressing commits fall in the interval between a round and the next", () => {
    const r1 = review({ id: 1, commitId: "c1", submittedAt: "2026-07-01T02:00:00Z" });
    const r2 = review({ id: 2, commitId: "c2", submittedAt: "2026-07-01T06:00:00Z" });
    const commits = [
      commit({ sha: "c1", committedAt: "2026-07-01T01:00:00Z" }),
      // between round 1 (last review @02:00) and round 2 (first review @06:00)
      commit({ sha: "c2", committedAt: "2026-07-01T04:00:00Z" }),
      commit({ sha: "c3", committedAt: "2026-07-01T05:00:00Z" }),
      // after round 2's last review → tail commit of the final round
      commit({ sha: "c4", committedAt: "2026-07-01T08:00:00Z" }),
    ];
    const out = deriveRounds(commits, [r1, r2]);
    expect(out.rounds[0]?.addressingCommits.map((c) => c.sha)).toEqual(["c2", "c3"]);
    expect(out.rounds[1]?.addressingCommits.map((c) => c.sha)).toEqual(["c4"]);
  });

  test("PENDING reviews are excluded", () => {
    const pending = review({ id: 9, state: "PENDING", submittedAt: null, commitId: "c1" });
    const submitted = review({ id: 1, commitId: "c1", submittedAt: "2026-07-01T10:00:00Z" });
    const out = deriveRounds([commit({ sha: "c1" })], [pending, submitted]);
    expect(out.rounds).toHaveLength(1);
    expect(out.rounds[0]?.reviews.map((r) => r.id)).toEqual([1]);
  });

  test("a review whose commit is absent from the commit list is an orphaned round", () => {
    const r = review({ id: 1, commitId: "force-pushed-away", submittedAt: "2026-07-01T10:00:00Z" });
    const out = deriveRounds([commit({ sha: "c1" })], [r]);
    expect(out.rounds[0]).toMatchObject({ baseSha: "force-pushed-away", orphaned: true });
  });

  test("entries interleave rounds and addressing commits in time order", () => {
    const r1 = review({ id: 1, commitId: "c1", submittedAt: "2026-07-01T02:00:00Z" });
    const r2 = review({ id: 2, commitId: "c2", submittedAt: "2026-07-01T06:00:00Z" });
    const commits = [
      commit({ sha: "c1", committedAt: "2026-07-01T01:00:00Z" }),
      commit({ sha: "c2", committedAt: "2026-07-01T04:00:00Z" }),
    ];
    const out = deriveRounds(commits, [r1, r2]);
    // round1 @02:00, commit c2 @04:00, round2 @06:00
    expect(
      out.entries.map((e) => (e.kind === "round" ? `round-${e.round.index}` : e.commit.sha)),
    ).toEqual(["round-0", "c2", "round-1"]);
  });
});
