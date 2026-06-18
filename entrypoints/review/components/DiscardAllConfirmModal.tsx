// Confirmation modal for "Discard all".
// Dropping every pending review item (comment/suggestion drafts and in-progress
// suggestion edits) is destructive and unrecoverable, so this confirms the count
// and intent before anything is cleared.

interface Props {
  /** How many pending items will be discarded (for the headline). */
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

function plural(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

export function DiscardAllConfirmModal({ count, onConfirm, onCancel, loading }: Props) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm discard all pending review"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal__title">Discard all pending review?</h3>
        <p>
          This permanently drops {plural(count, "pending item")} — every drafted comment and
          suggestion edit across all files.
        </p>
        <p className="notice--muted" style={{ fontSize: 12 }}>
          This can't be undone.
        </p>
        <div className="modal__footer">
          <button type="button" className="btn btn--sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={onConfirm}
            disabled={loading || count === 0}
          >
            Discard all
          </button>
        </div>
      </div>
    </div>
  );
}
