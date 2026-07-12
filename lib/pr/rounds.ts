// Round derivation — reconstructs review↔fix "rounds" from a PR's reviews and
// commits. Pure: no I/O, no persistence, rebuilt every session.
//
// A round is a burst of reviews sitting on the same commit (all reviewers who
// looked at that revision), followed by the commits that address it. See the
// R9 plan §2.2/§2.3 and docs/adr/0005 §2 (commits/reviews join a full refresh).

import type { PrCommit, PrReview } from "./types";

/** One review↔fix round: the reviews submitted against `baseSha`, plus the
 *  commits pushed to address them (up to the next round's first review). */
export type Round = {
  index: number;
  /** The commit the round's reviews were submitted against (review.commitId). */
  baseSha: string;
  /** Reviews in this round, oldest-first. */
  reviews: PrReview[];
  /** Commits addressing this round, oldest-first. */
  addressingCommits: PrCommit[];
  /** True when `baseSha` is absent from the PR's commit list — a force-push
   *  rewrote history out from under the review. The round is still shown.
   *  simplify: no git-DAG reconstruction; upgrade via PrCommit.parents. */
  orphaned: boolean;
};

/** A merged, time-sorted rail of rounds and their addressing commits. */
export type TimelineEntry =
  | { kind: "round"; at: string; round: Round }
  | { kind: "commit"; at: string; commit: PrCommit };

export type Timeline = {
  rounds: Round[];
  entries: TimelineEntry[];
};

/** ISO-8601 timestamps compare lexicographically. */
function byTimeAsc<T>(at: (x: T) => string) {
  return (a: T, b: T) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0);
}

export function deriveRounds(commits: PrCommit[], reviews: PrReview[]): Timeline {
  // 1. Drop PENDING (never submitted → no timestamp, not part of history).
  const submitted = reviews
    .filter((r) => r.state !== "PENDING" && r.submittedAt !== null)
    .sort(byTimeAsc((r) => r.submittedAt ?? ""));

  // 2. Group consecutive reviews sharing a commitId into one round.
  const rounds: Round[] = [];
  for (const review of submitted) {
    const last = rounds[rounds.length - 1];
    if (last && last.baseSha === review.commitId) {
      last.reviews.push(review);
    } else {
      rounds.push({
        index: rounds.length,
        baseSha: review.commitId,
        reviews: [review],
        addressingCommits: [],
        orphaned: false,
      });
    }
  }

  // 3. Mark orphaned rounds (baseSha not among the fetched commits).
  const commitShas = new Set(commits.map((c) => c.sha));
  for (const round of rounds) {
    if (!commitShas.has(round.baseSha)) round.orphaned = true;
  }

  // 4. Assign addressing commits: a commit belongs to the last round whose
  //    final review predates it. Commits before the first round are prologue
  //    (the code under review) and are not addressing anything.
  const sortedCommits = [...commits].sort(byTimeAsc((c) => c.committedAt));
  const roundStart = (r: Round) => r.reviews[0]?.submittedAt ?? "";
  const roundEnd = (r: Round) => r.reviews[r.reviews.length - 1]?.submittedAt ?? "";
  for (const commit of sortedCommits) {
    // Find the last round whose last review is at or before this commit.
    let owner: Round | undefined;
    for (const round of rounds) {
      if (roundEnd(round) <= commit.committedAt) owner = round;
      else break;
    }
    if (owner) owner.addressingCommits.push(commit);
  }

  // 5. Merged time-sorted rail: each round (at its first review) plus each
  //    addressing commit, interleaved by timestamp.
  const entries: TimelineEntry[] = [];
  for (const round of rounds) {
    entries.push({ kind: "round", at: roundStart(round), round });
    for (const commit of round.addressingCommits) {
      entries.push({ kind: "commit", at: commit.committedAt, commit });
    }
  }
  entries.sort(byTimeAsc((e) => e.at));

  return { rounds, entries };
}
