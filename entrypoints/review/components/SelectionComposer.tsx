// New-comment composer, rendered as an item inside the unified review list
// (no separate block). It shows the *content* of the selected text and a field
// to attach a comment. Add confirms it as a pending item; Discard throws the
// input away. No review/issue/suggestion tags, no filename.
import type { SourceAnchor } from "../../../lib/anchor";
import { isSubmitChord } from "../keys";

interface Props {
  anchor: SourceAnchor;
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
  onDiscard: () => void;
}

export function SelectionComposer({ anchor, value, onChange, onAdd, onDiscard }: Props) {
  return (
    <div className="thread review-item--composer">
      <div className="composer__quote">{anchor.quotedText}</div>
      <textarea
        className="field"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (isSubmitChord(e)) {
            e.preventDefault();
            onAdd();
          }
        }}
        rows={3}
        placeholder="Comment on the selected range"
        autoFocus
      />
      <div className="composer__row">
        <button type="button" className="btn btn--primary btn--sm" onClick={onAdd}>
          Add
        </button>
        <button type="button" className="btn btn--sm" onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}
