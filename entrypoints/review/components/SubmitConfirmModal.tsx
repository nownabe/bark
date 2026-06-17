// Confirmation modal for "Submit review" — task 3.
// Lists the pending items (drafts + the reviewer's live suggestions) that are
// about to be sent to GitHub so the reviewer can confirm before submitting.
import type { ReviewEntry } from "../reviewItems";

interface Props {
  items: ReviewEntry[];
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

function lineLabel(range: { sl: number; el: number }): string {
  return `L${range.sl}${range.el !== range.sl ? `–L${range.el}` : ""}`;
}

export function SubmitConfirmModal({ items, onConfirm, onCancel, loading }: Props) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm submit review"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal__title">Submit review ({items.length})</h3>
        {items.length === 0 ? (
          <p className="empty">Nothing to submit.</p>
        ) : (
          <div className="modal__list">
            {items.map((e) => {
              // The modal only lists pending items (drafts + live suggestions).
              const v =
                e.kind === "liveSuggestion"
                  ? {
                      cid: e.suggestion.cid,
                      path: e.suggestion.path,
                      range: e.suggestion.range,
                      inDiff: e.suggestion.inDiff,
                      body: e.suggestion.body,
                      isSuggestion: true,
                      quote: e.suggestion.quote,
                      replacement: e.suggestion.replacement,
                    }
                  : e.kind === "draft"
                    ? {
                        cid: e.draft.cid,
                        path: e.draft.path,
                        range: e.draft.range,
                        inDiff: e.draft.inDiff,
                        body: e.draft.body,
                        isSuggestion: e.draft.kind === "suggestion",
                        quote: e.draft.quote,
                        replacement: e.draft.suggestion ?? "",
                      }
                    : null;
              if (!v) return null;
              return (
                <div key={v.cid} className="thread">
                  <div className="comment__meta">
                    <span>{lineLabel(v.range)}</span>
                  </div>
                  {v.body ? <div className="comment__body">{v.body}</div> : null}
                  {v.isSuggestion ? (
                    <>
                      <div className="sugg-old">{v.quote}</div>
                      <div className="sugg-new">{v.replacement || "(delete)"}</div>
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
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
            Submit review
          </button>
        </div>
      </div>
    </div>
  );
}
