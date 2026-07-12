// One review↔fix round in the History panel: the round header
// (`Round N @ <sha7>` + each review's state/author), the comments made in
// that round with their status badges, and the commits that addressed it.
//
// Pure presentation. The parent shapes the comment rows (quote, author,
// status) and owns the jump/highlight state; this component only renders and
// fires `onJumpToCommit`.

import type { CommentRoundStatus } from "../../../lib/pr/commentStatus";
import type { Round } from "../../../lib/pr/rounds";

/** A comment surfaced under a round, pre-shaped by the parent. */
export type HistoryCommentRow = {
  id: string;
  author: string;
  quote: string;
  status: CommentRoundStatus;
};

export type RoundItemProps = {
  round: Round;
  comments: HistoryCommentRow[];
  /** Sha of the commit currently highlighted by a jump, or null. */
  highlightedSha: string | null;
  onJumpToCommit: (sha: string) => void;
};

/** Short 7-char SHA, GitHub-style. */
function sha7(sha: string): string {
  return sha.slice(0, 7);
}

/** First non-empty line of a commit message. */
function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? "";
}

/** Badge label + modifier class for a comment's round status. `resolved`,
 *  `outdated` and `open` reuse the shared badge vocabulary; `addressed` is
 *  rendered as a clickable chip instead (see below), so it needs no badge. */
const STATUS_BADGE: Record<CommentRoundStatus["status"], { label: string; cls: string } | null> = {
  resolved: { label: "resolved", cls: "badge--resolved" },
  outdated: { label: "outdated", cls: "badge--outdated" },
  open: { label: "open", cls: "badge--open" },
  addressed: null,
};

function AddressedChip({
  sha,
  onJumpToCommit,
}: {
  sha: string;
  onJumpToCommit: (sha: string) => void;
}) {
  return (
    <button
      type="button"
      className="history__addressed-chip"
      title={`Jump to the commit that fixed this (${sha7(sha)})`}
      onClick={() => onJumpToCommit(sha)}
    >
      fixed in <span className="sha">{sha7(sha)}</span>
    </button>
  );
}

function CommentRow({
  row,
  onJumpToCommit,
}: {
  row: HistoryCommentRow;
  onJumpToCommit: (sha: string) => void;
}) {
  const badge = STATUS_BADGE[row.status.status];
  // Both `addressed` and (when co-occurring) `outdated` carry a first-touch
  // sha; surface the jump chip in either case.
  const addressedBySha =
    row.status.status === "addressed" || row.status.status === "outdated"
      ? row.status.addressedBySha
      : undefined;
  return (
    <div className="history__comment">
      <div className="history__comment-head">
        <span className="history__comment-author">{row.author}</span>
        {badge ? <span className={`badge ${badge.cls}`}>{badge.label}</span> : null}
        {addressedBySha ? (
          <AddressedChip sha={addressedBySha} onJumpToCommit={onJumpToCommit} />
        ) : null}
      </div>
      {row.quote ? <div className="history__comment-quote">{row.quote}</div> : null}
    </div>
  );
}

export function RoundItem({ round, comments, highlightedSha, onJumpToCommit }: RoundItemProps) {
  return (
    <section
      className={`history__round${round.orphaned ? " history__round--orphaned" : ""}`}
      data-round-index={round.index}
    >
      <header className="history__round-head">
        <h3 className="history__round-title">
          Round {round.index + 1} <span className="history__at">@</span>{" "}
          <span className="sha">{sha7(round.baseSha)}</span>
        </h3>
        {round.orphaned ? (
          <span
            className="history__orphaned"
            title="A force-push rewrote this commit out of history"
          >
            orphaned
          </span>
        ) : null}
      </header>

      <ul className="history__reviews">
        {round.reviews.map((r) => (
          <li key={r.id} className="history__review">
            <span className="history__review-author">{r.author.login}</span>
            <span className="history__review-state">{r.state}</span>
          </li>
        ))}
      </ul>

      {comments.length > 0 ? (
        <div className="history__comments">
          {comments.map((row) => (
            <CommentRow key={row.id} row={row} onJumpToCommit={onJumpToCommit} />
          ))}
        </div>
      ) : null}

      {round.addressingCommits.length > 0 ? (
        <ul className="history__commits">
          {round.addressingCommits.map((c) => (
            <li
              key={c.sha}
              data-commit-sha={c.sha}
              className={`history__commit${
                highlightedSha === c.sha ? " history__commit--highlight" : ""
              }`}
            >
              <span className="sha">{sha7(c.sha)}</span>{" "}
              <span className="history__commit-author">({c.author.login})</span>{" "}
              <span className="history__commit-msg">— {firstLine(c.message)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
