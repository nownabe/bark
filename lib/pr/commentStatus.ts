// Per-comment round status — where a review comment stands relative to the
// commits pushed after it. Pure; derived from RemoteState + the already-
// computed re-anchor display positions. See the R9 plan §2.3.
//
// Precedence (highest first):
//   1. resolved  — the thread is resolved on GitHub.
//   2. outdated  — the comment's region no longer maps to head (reuse the
//                  AppState re-anchor result verbatim; no recompute). When a
//                  first-touch commit can still be identified it is carried
//                  along as `addressedBySha` so the History UI can offer a
//                  "fixed in <sha>" jump even on an unmappable comment — in
//                  practice a region that was edited is usually ALSO unmappable
//                  at head, so without this the informative sha would be hidden.
//   3. addressed — the region stopped surviving in some commit strictly after
//                  comment.anchor.sha; the FIRST such commit is addressedBySha.
//   4. open      — still standing, region intact through every later commit.

import { buildLineMap } from "./linemap";
import type { DisplayPosition } from "./reanchor";
import { regionSurvives } from "./reanchor";
import type { Comment, LocalId, PrCommit } from "./types";

export type CommentRoundStatus =
  | { status: "resolved" }
  | { status: "outdated"; addressedBySha?: string }
  | { status: "addressed"; addressedBySha: string }
  | { status: "open" };

export type CommentStatusInput = {
  /** Whether the comment's thread is resolved. */
  resolvedByThreadId: (threadId: string) => boolean;
  /** The re-anchor result AppState already computed for this comment. */
  displayPositionOf: (commentId: LocalId) => DisplayPosition | undefined;
  /** All PR commits (any order; sorted internally by committedAt). */
  commits: PrCommit[];
  /** Source of a file at a commit, or undefined if not fetched (404-tolerant). */
  fileSourceAt: (sha: string, path: string) => string | undefined;
};

function fileKey(sha: string, path: string): string {
  return `${sha}\0${path}`;
}

/** Derive each comment's round status. The line-map used by the "addressed"
 *  walk is memoized by `(oldSha, newSha, path)` so two comments on the same
 *  file sharing an anchor sha don't each recompute the O(n·m) LCS.
 *
 *  simplify: still O(commits × comments) region checks in the worst case — a
 *  comment with a distinct anchor sha walks every later commit. Upgrade path:
 *  short-circuit with per-commit changed-file lists so a commit that didn't
 *  touch the path is skipped without a source fetch or line-map. */
export function deriveCommentStatuses(
  comments: Comment[],
  input: CommentStatusInput,
): Map<LocalId, CommentRoundStatus> {
  const sortedCommits = [...input.commits].sort((a, b) =>
    a.committedAt < b.committedAt ? -1 : a.committedAt > b.committedAt ? 1 : 0,
  );
  const committedAtBySha = new Map(sortedCommits.map((c) => [c.sha, c.committedAt]));
  const lineMapMemo = new Map<string, Map<number, number>>();
  const out = new Map<LocalId, CommentRoundStatus>();

  for (const comment of comments) {
    out.set(comment.id, statusFor(comment, input, sortedCommits, committedAtBySha, lineMapMemo));
  }
  return out;
}

function statusFor(
  comment: Comment,
  input: CommentStatusInput,
  sortedCommits: PrCommit[],
  committedAtBySha: Map<string, string>,
  lineMapMemo: Map<string, Map<number, number>>,
): CommentRoundStatus {
  if (input.resolvedByThreadId(comment.threadId)) {
    return { status: "resolved" };
  }
  const addressedBySha = firstAddressingCommit(
    comment,
    input,
    sortedCommits,
    committedAtBySha,
    lineMapMemo,
  );
  // A region that was edited is usually unmappable at head, so `outdated` and
  // `addressed` co-occur. Keep `outdated` as the primary state (it drives the
  // existing badge vocabulary) but attach the first-touch sha when we found one
  // so the History UI can still offer a "fixed in <sha>" jump.
  if (input.displayPositionOf(comment.id)?.status === "outdated") {
    return addressedBySha ? { status: "outdated", addressedBySha } : { status: "outdated" };
  }
  return addressedBySha ? { status: "addressed", addressedBySha } : { status: "open" };
}

/** Walk commits strictly after the comment's anchor commit and return the sha
 *  of the first one where the anchored region no longer survives, or null. */
function firstAddressingCommit(
  comment: Comment,
  input: CommentStatusInput,
  sortedCommits: PrCommit[],
  committedAtBySha: Map<string, string>,
  lineMapMemo: Map<string, Map<number, number>>,
): string | null {
  const { anchor, path } = comment;
  const oldSource = input.fileSourceAt(anchor.sha, path);
  // No baseline source (force-pushed-away anchor, or never fetched) → can't
  // prove the region changed, so never falsely mark addressed.
  if (oldSource === undefined) return null;
  const anchorAt = committedAtBySha.get(anchor.sha);
  // Anchor commit absent from the fetched list → same conservative choice.
  if (anchorAt === undefined) return null;

  for (const commit of sortedCommits) {
    if (commit.committedAt <= anchorAt) continue; // strictly after the anchor
    const newSource = input.fileSourceAt(commit.sha, path);
    // A missing FileContent for this (commit, path) is skipped, not treated as
    // a change — we only conclude "addressed" from a fetched, differing source.
    if (newSource === undefined) continue;

    const key = fileKey(anchor.sha, path) + "\0" + commit.sha;
    let lineMap = lineMapMemo.get(key);
    if (lineMap === undefined) {
      lineMap = buildLineMap(oldSource, newSource);
      lineMapMemo.set(key, lineMap);
    }
    if (!regionSurvives(anchor, oldSource, newSource, lineMap).survives) {
      return commit.sha;
    }
  }
  return null;
}
