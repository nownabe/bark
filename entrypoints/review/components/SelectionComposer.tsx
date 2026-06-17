// Comment composer shown when the reviewer selects text in the body.
// It surfaces the routing (review / issue), the line range, and — importantly —
// the *content* of the selected text so the reviewer can see what they are
// commenting on without looking back at the editor (task 6).
import type { SourceAnchor } from "../../../lib/anchor";

interface Props {
  anchor: SourceAnchor;
  routing: { kind: "review" | "issue" } | null;
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
  onCancel: () => void;
}

export function SelectionComposer({ anchor, routing, value, onChange, onAdd, onCancel }: Props) {
  return (
    <section className="panel">
      <h2 className="panel__title">Comment</h2>
      {routing ? (
        <p className="composer__routing">
          {routing.kind === "review" ? (
            <span className="badge badge--review">review</span>
          ) : (
            <span className="badge badge--issue">issue + permalink</span>
          )}{" "}
          <span className="notice--muted">
            L{anchor.startLine}
            {anchor.endLine !== anchor.startLine ? `–L${anchor.endLine}` : ""}
          </span>
        </p>
      ) : null}
      <div className="composer__quote">{anchor.quotedText}</div>
      <textarea
        className="field"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder="Comment on the selected range"
      />
      <div className="composer__row">
        <button type="button" className="btn btn--primary btn--sm" onClick={onAdd}>
          Add
        </button>
        <button type="button" className="btn btn--sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
