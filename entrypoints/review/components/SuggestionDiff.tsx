// A suggestion shown in the review list (sidebar) as old → new. Both lines show
// their full text so the unchanged context stays readable; only the changed
// substrings are emphasized (char-level, via charDiffs) — struck-through in the
// old line, highlighted in the new line. This mirrors how comments anchor to a
// character range rather than whole lines.
import { charDiffs } from "../../../lib/suggest";

export function SuggestionDiff({ before, after }: { before: string; after: string }) {
  const diffs = charDiffs(before, after);
  return (
    <>
      <div className="sugg-old">
        {diffs.map(([op, text], i) =>
          op === 1 ? null : (
            <span key={i} className={op === -1 ? "sugg-chg" : "sugg-eq"}>
              {text}
            </span>
          ),
        )}
      </div>
      <div className="sugg-new">
        {after.length === 0 ? (
          <span className="sugg-note">(delete)</span>
        ) : (
          diffs.map(([op, text], i) =>
            op === -1 ? null : (
              <span key={i} className={op === 1 ? "sugg-chg" : "sugg-eq"}>
                {text}
              </span>
            ),
          )
        )}
      </div>
    </>
  );
}
