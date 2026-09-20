// Confirmation modal for "Submit review".
// Summarizes what will actually be posted to GitHub — split the way submitReview
// posts it (one review for in-diff items, separate PR comments for out-of-diff) —
// then lists the individual pending items so the reviewer can confirm with full
// understanding before anything goes out.
import type { PullStatus } from "../../../lib/github";
import {
  groupPendingByFile,
  summarizePending,
  type PendingItem,
  type SubmitGroup,
} from "../reviewItems";
import { SuggestionDiff } from "./SuggestionDiff";

interface Props {
  items: PendingItem[];
  /** The PR the items will be posted to (for the headline). */
  target?: { owner: string; repo: string; number: number };
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  /** Primary button label. Defaults to "Submit review" (reviewer mode). */
  submitLabel?: string;
  /** PR lifecycle, so a merged/closed PR is called out before posting (#288). */
  prStatus?: PullStatus | null;
}

/** Comments on a merged or closed PR still post — they are just unlikely to be
 *  read — so this warns rather than blocks. A commit is refused outright by the
 *  Planner (issue #288). */
function lifecycleWarning(prStatus: PullStatus | null | undefined): string | null {
  if (prStatus === "merged") {
    return "This pull request is merged. Comments still post, but nobody may read them, and file edits will not be committed.";
  }
  if (prStatus === "closed") {
    return "This pull request is closed. Comments still post, but nobody may read them, and file edits will not be committed.";
  }
  return null;
}

function lineLabel(range: { sl: number; el: number }): string {
  return `L${range.sl}${range.el !== range.sl ? `–L${range.el}` : ""}`;
}

function plural(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

/** "2 comments and 1 suggestion", "1 comment", etc. */
function groupText(g: SubmitGroup): string {
  const parts: string[] = [];
  if (g.comments) parts.push(plural(g.comments, "comment"));
  if (g.suggestions) parts.push(plural(g.suggestions, "suggestion"));
  return parts.join(" and ");
}

export function SubmitConfirmModal({
  items,
  target,
  onConfirm,
  onCancel,
  loading,
  submitLabel,
  prStatus,
}: Props) {
  const summary = summarizePending(items);
  const buttonLabel = submitLabel ?? "Submit review";
  const warning = lifecycleWarning(prStatus);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm submit review"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal__title">Submit review</h3>
        {warning ? (
          <p className="notice--error" style={{ fontSize: 12 }}>
            {warning}
          </p>
        ) : null}
        {items.length === 0 ? (
          <p className="empty">Nothing to submit.</p>
        ) : (
          <>
            <div className="submit-summary">
              <p>
                Posting {plural(summary.total, "item")}
                {target ? (
                  <>
                    {" "}
                    to{" "}
                    <strong>
                      {target.owner}/{target.repo} #{target.number}
                    </strong>
                  </>
                ) : null}
                :
              </p>
              <ul>
                {summary.review.total > 0 ? (
                  <li>
                    <strong>One review</strong> with {groupText(summary.review)} on the diff.
                  </li>
                ) : null}
                {summary.direct.total > 0 ? (
                  <li>
                    {groupText(summary.direct)} posted directly on the PR (outside the diff)
                    {summary.direct.suggestions > 0
                      ? " — out-of-diff suggestions have no Apply button"
                      : ""}
                    .
                  </li>
                ) : null}
                {summary.commit.editedFiles > 0 || summary.commit.acceptances > 0 ? (
                  <li>
                    <strong>One commit</strong> updating{" "}
                    {plural(summary.commit.editedFiles, "file")}
                    {summary.commit.acceptances > 0
                      ? `, applying ${plural(summary.commit.acceptances, "accepted suggestion")}`
                      : ""}
                    .
                  </li>
                ) : null}
              </ul>
              <p className="notice--muted" style={{ fontSize: 12 }}>
                This posts to GitHub immediately and can't be undone from Bark.
              </p>
            </div>
            <div className="modal__list">
              {groupPendingByFile(items).map(({ path, items: groupItems }) => (
                <div key={path} className="submit-group">
                  <div className="submit-group__file">{path}</div>
                  {groupItems.map((item) => {
                    if (item.kind === "acceptedSuggestion") {
                      return (
                        <div key={`accept:${item.commentId}`} className="thread">
                          <div className="comment__meta">
                            <span>L{item.line}</span>
                            <span className="tag tag--accept">Accept</span>
                          </div>
                          <SuggestionDiff before={item.quote} after={item.replacement} />
                        </div>
                      );
                    }
                    if (item.kind === "edit") {
                      // Author edits are summarized by the "One commit" line above —
                      // no per-edit detail in the list (would duplicate the summary).
                      return null;
                    }
                    const v =
                      item.kind === "suggestion"
                        ? {
                            cid: item.suggestion.cid,
                            range: item.suggestion.range,
                            body: item.suggestion.body,
                            isSuggestion: true,
                            quote: item.suggestion.quote,
                            replacement: item.suggestion.replacement,
                          }
                        : {
                            cid: item.draft.cid,
                            range: item.draft.range,
                            body: item.draft.body,
                            isSuggestion: item.draft.kind === "suggestion",
                            quote: item.draft.quote,
                            replacement: item.draft.suggestion ?? "",
                          };
                    return (
                      <div key={v.cid} className="thread">
                        <div className="comment__meta">
                          <span>{lineLabel(v.range)}</span>
                        </div>
                        {v.isSuggestion ? (
                          <>
                            <SuggestionDiff before={v.quote ?? ""} after={v.replacement} />
                            {v.body ? <div className="comment__body">{v.body}</div> : null}
                          </>
                        ) : (
                          <>
                            {/* the text being commented on */}
                            {v.quote ? <div className="composer__quote">{v.quote}</div> : null}
                            {v.body ? <div className="comment__body">{v.body}</div> : null}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        )}
        <div className="modal__footer">
          <button type="button" className="btn btn--sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={onConfirm}
            disabled={loading || items.length === 0}
          >
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
