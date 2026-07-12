// Topbar controls for the R10 baseline redline overlay (§7.10).
//
// Three affordances, all prop-driven (state lives in App, like the other
// Topbar popovers):
//   - a "Redline" toggle chip (accent when active), disabled with a tooltip
//     when no baseline exists, showing the baseline's short SHA;
//   - a baseline selector popover (Last visit / PR base), reusing the PrInfo/
//     Help outside-click + ref pattern;
//   - prev/next jump-to-change buttons with a change count.
//
// The component never decides *whether* a redline is possible — App gates that
// (preview mode, no local edits, a baseline present) and passes the results in.

import type { RefObject } from "react";

export type RedlineBaselineSource = "lastVisit" | "prBase";

export type RedlineControlsProps = {
  /** Whether the redline overlay is currently on. */
  enabled: boolean;
  /** The active baseline commit SHA, or null when none is available (first
   *  visit, or PR-base ref unknown). Null disables the toggle. */
  baselineSha: string | null;
  /** Which baseline the viewer picked. */
  baselineSource: RedlineBaselineSource;
  /** The PR base branch name, shown as the "PR base" option's detail. */
  prBaseRef: string | null;
  /** The last-seen head SHA, shown as the "Last visit" option's detail. */
  lastVisitSha: string | null;
  /** Number of redline change segments in the current file (0 hides jump). */
  changeCount: number;
  showSelector: boolean;
  selectorBtnRef: RefObject<HTMLButtonElement>;
  selectorRef: RefObject<HTMLDivElement>;
  onToggle: () => void;
  onChangeBaselineSource: (source: RedlineBaselineSource) => void;
  onToggleSelector: () => void;
  onJumpPrev: () => void;
  onJumpNext: () => void;
};

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "";
}

export function RedlineControls({
  enabled,
  baselineSha,
  baselineSource,
  prBaseRef,
  lastVisitSha,
  changeCount,
  showSelector,
  selectorBtnRef,
  selectorRef,
  onToggle,
  onChangeBaselineSource,
  onToggleSelector,
  onJumpPrev,
  onJumpNext,
}: RedlineControlsProps) {
  const hasBaseline = baselineSha !== null;
  const active = enabled && hasBaseline;
  const showJump = active && changeCount > 0;
  return (
    <div className="redline">
      <button
        type="button"
        className="redline-toggle"
        aria-pressed={active}
        disabled={!hasBaseline}
        onClick={onToggle}
        title={
          hasBaseline
            ? "Toggle the redline overlay (changes since the baseline)"
            : "No previous visit to compare — the redline needs an earlier baseline."
        }
      >
        Redline
        {hasBaseline ? <span className="redline-toggle__sha">{short(baselineSha)}</span> : null}
      </button>

      {hasBaseline ? (
        <button
          type="button"
          ref={selectorBtnRef}
          className="redline-selector-btn"
          aria-label="Choose redline baseline"
          title="Choose redline baseline"
          onClick={onToggleSelector}
        >
          ▾
        </button>
      ) : null}

      {showJump ? (
        <div className="redline-jump">
          <button
            type="button"
            className="btn btn--icon btn--sm"
            aria-label="Previous change"
            title="Previous change"
            onClick={onJumpPrev}
          >
            ‹
          </button>
          <span className="redline-jump__count" title="Changes since the baseline">
            {changeCount}
          </span>
          <button
            type="button"
            className="btn btn--icon btn--sm"
            aria-label="Next change"
            title="Next change"
            onClick={onJumpNext}
          >
            ›
          </button>
        </div>
      ) : null}

      {showSelector ? (
        <div className="popover popover--redline" role="dialog" ref={selectorRef}>
          <h3>Redline baseline</h3>
          <ul className="redline-options">
            <li>
              <button
                type="button"
                className="redline-option"
                aria-pressed={baselineSource === "lastVisit"}
                disabled={!lastVisitSha}
                onClick={() => onChangeBaselineSource("lastVisit")}
              >
                <span>Last visit</span>
                <span className="redline-option__detail">{short(lastVisitSha)}</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="redline-option"
                aria-pressed={baselineSource === "prBase"}
                disabled={!prBaseRef}
                onClick={() => onChangeBaselineSource("prBase")}
              >
                <span>PR base</span>
                <span className="redline-option__detail">{prBaseRef ?? ""}</span>
              </button>
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}
