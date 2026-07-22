// Floating debug affordance (bottom-left). Always rendered; a click toggles
// a popover with current internal state — role, view mode, head SHA, edit /
// draft counts, and (when text is selected) the active anchor info and the
// body that would be posted, including the live "round-trip" check.

import type { SourceAnchor } from "../../../lib/anchor";
import type { CommentMetadata } from "../../../lib/metadata";
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
  previewBody: string;
  restored: { meta: CommentMetadata | null } | null;
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
  previewBody,
  restored,
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
              <div style={{ marginTop: 8 }}>GitHub body to be posted:</div>
              <pre>{previewBody}</pre>
              {restored?.meta ? (
                <p style={{ color: "var(--green)" }}>
                  ✓ live round-trip OK: L{restored.meta.range.sl}:{restored.meta.range.sc}–L
                  {restored.meta.range.el}:{restored.meta.range.ec}
                </p>
              ) : null}
            </>
          ) : (
            <p className="empty">Select text in the body to see anchor info.</p>
          )}
        </div>
      ) : null}
    </>
  );
}
