// Confirmation modal for "Submit review" — task 3.
// Lists the pending items (drafts + the reviewer's live suggestions) that are
// about to be sent to GitHub so the reviewer can confirm before submitting.
import type { PendingItem } from "../reviewItems";

interface Props {
  items: PendingItem[];
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
            {items.map((item) => {
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
