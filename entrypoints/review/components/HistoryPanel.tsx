// The read-only History view of the sidebar: the list of review↔fix rounds
// reconstructed from the PR's reviews + commits (AppState.timeline), each
// rendered by RoundItem. Pure presentation, prop-drilled like ReviewSidebar —
// the parent derives `rounds` and per-round comment rows from AppState and
// owns the jump/highlight state.

import type { Round } from "../../../lib/pr/rounds";
import { type HistoryCommentRow, RoundItem } from "./RoundItem";

export type { HistoryCommentRow };

export type HistoryPanelProps = {
  rounds: Round[];
  /** Comment rows to surface under each round, keyed by the round's baseSha. */
  commentsByRound: Map<string, HistoryCommentRow[]>;
  /** Sha of the commit currently highlighted by a jump, or null. */
  highlightedSha: string | null;
  onJumpToCommit: (sha: string) => void;
};

export function HistoryPanel({
  rounds,
  commentsByRound,
  highlightedSha,
  onJumpToCommit,
}: HistoryPanelProps) {
  if (rounds.length === 0) {
    return <p className="empty">No review rounds yet.</p>;
  }
  return (
    <div className="history">
      {rounds.map((round) => (
        <RoundItem
          key={`${round.index}-${round.baseSha}`}
          round={round}
          comments={commentsByRound.get(round.baseSha) ?? []}
          highlightedSha={highlightedSha}
          onJumpToCommit={onJumpToCommit}
        />
      ))}
    </div>
  );
}
