// Floating debug affordance (bottom-left). Always rendered; a click toggles
// a popover with current internal state — role, view mode, head SHA, edit /
// draft counts, and (when text is selected) the active anchor info.

import type { SourceAnchor } from "../../../lib/anchor";
import type { Role } from "../reviewItems";
import type { ViewMode } from "../uiHelpers";

export type DebugFabProps = {
  show: boolean;
  onToggle: () => void;
  onClose: () => void;
  role: Role;
  viewMode: ViewMode;
  headSha: string | null;
  /** Whether the body has been locally edited (source !== baseSource). */
  edited: boolean;
  draftsCount: number;
  anchor: SourceAnchor | null;
  /** Debug-only manual full refresh (ADR 0005 §5). Omitted while the
   *  bootstrap refresh function is not available; the button then hides. */
  onRefresh?: () => void;
};

export function DebugFab({
  show,
  onToggle,
  onClose,
  role,
  viewMode,
  headSha,
  edited,
  draftsCount,
  anchor,
  onRefresh,
}: DebugFabProps) {
  return (
    <>
      <button
        type="button"
        className="debug-fab"
        title="Debug info"
        aria-label="Debug info"
        onClick={onToggle}
      >
        🐛
      </button>
      {show ? (
        <div className="debug-popover debug" role="dialog">
          <div className="composer__row" style={{ justifyContent: "space-between", marginTop: 0 }}>
            <strong>Debug</strong>
            <span>
              {onRefresh ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  style={{ marginRight: 8 }}
                  onClick={onRefresh}
                  title="Force a full RemoteState refresh from GitHub"
                >
                  Refresh
                </button>
              ) : null}
              <button type="button" className="btn btn--sm" onClick={onClose}>
                Close
              </button>
            </span>
          </div>
          <dl>
            <dt>role / view</dt>
            <dd>
              {role} / {viewMode}
            </dd>
            <dt>head</dt>
            <dd>{headSha ? headSha.slice(0, 7) : "-"}</dd>
            <dt>edited</dt>
            <dd>{edited ? "yes" : "no"}</dd>
            <dt>drafts</dt>
            <dd>{draftsCount}</dd>
          </dl>
          {anchor ? (
            <>
              <dl>
                <dt>offset</dt>
                <dd>
                  {anchor.startOffset}–{anchor.endOffset}
                </dd>
                <dt>range</dt>
                <dd>
                  L{anchor.startLine}:{anchor.startCol}–L{anchor.endLine}:{anchor.endCol}
                </dd>
              </dl>
              <div style={{ marginTop: 8 }}>quoted:</div>
              <pre>{anchor.quotedText}</pre>
            </>
          ) : (
            <p className="empty">Select text in the body to see anchor info.</p>
          )}
        </div>
      ) : null}
    </>
  );
}
