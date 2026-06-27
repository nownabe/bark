// The sticky review-surface top bar.
//
// Pure presentation: every piece of mutable state lives in the parent
// App; Topbar just reads props and forwards interactions through the
// supplied callbacks. The popover refs (info / help) are owned by the
// parent too, because they participate in outside-click logic that
// spans more than just this component.

import type { RefObject } from "react";
import {
  avatarUrl,
  type ChangedFile,
  type PrRef,
  type PullInfo,
  type PullStatus,
} from "../../../lib/github";
import type { Role } from "../reviewItems";
import { PR_STATUS_LABEL, type ViewMode } from "../uiHelpers";

export type TopbarProps = {
  prRef: PrRef | null;
  owner: string | null;
  repo: string | null;
  prNum: string | null;
  pull: PullInfo | null;
  prStatus: PullStatus | null;
  headSha: string | null;
  files: ChangedFile[];
  selectedPath: string | null;
  viewMode: ViewMode;
  loading: boolean;
  pendingCount: number;
  role: Role;
  token: string | null;
  showPrInfo: boolean;
  showHelp: boolean;
  prInfoBtnRef: RefObject<HTMLButtonElement>;
  prInfoRef: RefObject<HTMLDivElement>;
  helpBtnRef: RefObject<HTMLButtonElement>;
  helpRef: RefObject<HTMLDivElement>;
  onSelectPath: (path: string) => void;
  onChangeViewMode: (mode: ViewMode) => void;
  onAskSubmit: () => void;
  onAskDiscardAll: () => void;
  onTogglePrInfo: () => void;
  onToggleHelp: () => void;
  onClearToken: () => void;
};

export function Topbar({
  prRef,
  owner,
  repo,
  prNum,
  pull,
  prStatus,
  headSha,
  files,
  selectedPath,
  viewMode,
  loading,
  pendingCount,
  role,
  token,
  showPrInfo,
  showHelp,
  prInfoBtnRef,
  prInfoRef,
  helpBtnRef,
  helpRef,
  onSelectPath,
  onChangeViewMode,
  onAskSubmit,
  onAskDiscardAll,
  onTogglePrInfo,
  onToggleHelp,
  onClearToken,
}: TopbarProps) {
  const disablePendingActions = loading || pendingCount === 0;
  return (
    <header className="topbar">
      <span className="topbar__brand">
        <img className="topbar__logo" src="/icon/128.png" alt="" />
        Bark
      </span>
      {prRef ? (
        <>
          <div className="topbar__pr-head">
            <span className="topbar__pr-headline">
              <a
                className="topbar__pr-title"
                href={`https://github.com/${owner}/${repo}/pull/${prNum}`}
                target="_blank"
                rel="noreferrer"
                title={pull?.title ?? "Open this pull request on GitHub"}
              >
                {pull?.title ?? `${owner}/${repo} #${prNum}`}
              </a>
              {prStatus ? (
                <span className={`badge badge--pr badge--pr-${prStatus}`}>
                  {PR_STATUS_LABEL[prStatus]}
                </span>
              ) : null}
              {pull ? (
                <button
                  type="button"
                  ref={prInfoBtnRef}
                  className="topbar__info-btn"
                  title="Pull request details"
                  aria-label="Pull request details"
                  onClick={onTogglePrInfo}
                >
                  ℹ
                </button>
              ) : null}
            </span>
            <span className="topbar__pr-sub">
              {owner}/{repo} #{prNum}
              {headSha ? <> · @{headSha.slice(0, 7)}</> : null}
            </span>
          </div>
          {files.length > 0 ? (
            <select
              className="input"
              value={selectedPath ?? ""}
              onChange={(e) => onSelectPath(e.target.value)}
            >
              {files.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
          ) : null}
          <span className="topbar__spacer" />
          <div className="seg">
            <button
              type="button"
              aria-pressed={viewMode === "preview"}
              className="seg--dark"
              onClick={() => onChangeViewMode("preview")}
            >
              Preview
            </button>
            <button
              type="button"
              aria-pressed={viewMode === "raw"}
              className="seg--dark"
              onClick={() => onChangeViewMode("raw")}
            >
              Raw
            </button>
          </div>
          <button
            type="button"
            className="btn btn--icon"
            onClick={onAskDiscardAll}
            disabled={disablePendingActions}
            aria-label="Discard all pending items"
            title={
              role === "author"
                ? "Discard all pending items (comments, replies, accepted suggestions, edits)"
                : "Discard all pending review items (comments and suggestions) across every file"
            }
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 6h18" />
              <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <line x1="10" x2="10" y1="11" y2="17" />
              <line x1="14" x2="14" y1="11" y2="17" />
            </svg>
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={onAskSubmit}
            disabled={disablePendingActions}
            title={
              role === "author"
                ? "Review the staged comments, replies, accepted suggestions, and edits before submitting"
                : "Review the pending items from all files before submitting"
            }
          >
            {role === "author" ? `Submit (${pendingCount})` : `Submit review (${pendingCount})`}
          </button>
          <button
            type="button"
            ref={helpBtnRef}
            className="help-btn"
            title="Help"
            aria-label="Help"
            onClick={onToggleHelp}
          >
            ?
          </button>
        </>
      ) : (
        <span className="topbar__meta">sample document (no PR specified)</span>
      )}
      {showPrInfo && pull ? (
        <div className="popover popover--pr" role="dialog" ref={prInfoRef}>
          <h3>{pull.title || "(no title)"}</h3>
          <div className="pr-info__meta">
            <img
              className="comment__avatar"
              src={avatarUrl(pull.author, 40)}
              alt=""
              width={18}
              height={18}
              loading="lazy"
            />
            <span className="comment__author">{pull.author}</span>
            {prStatus ? (
              <span className={`badge badge--pr badge--pr-${prStatus}`}>
                {PR_STATUS_LABEL[prStatus]}
              </span>
            ) : null}
          </div>
          <div className="pr-info__body">{pull.body || "(no description)"}</div>
        </div>
      ) : null}
      {showHelp ? (
        <div className="popover" role="dialog" ref={helpRef}>
          <h3>How to use</h3>
          <ul>
            <li>The body is always editable (the Markdown source is canonical).</li>
            <li>
              <strong>Preview / Raw</strong>: switch the view (both editable).
            </li>
            <li>
              <strong>author</strong>: edit the body, accept reviewer suggestions, comment, and
              reply — all staged locally. <strong>Submit</strong> posts the comments/replies and
              creates one commit with every edit and every accepted suggestion in one go.
            </li>
            <li>
              <strong>reviewer</strong>: select text to comment. Editing the body is queued
              automatically as a suggestion (optionally annotate it with a comment).
            </li>
            <li>
              Pending and submitted items share one list; filter it from the list header. Send all
              pending items with <strong>Submit</strong> in the top bar — you confirm them first.
            </li>
            <li>
              Click a side item to jump to and highlight its place in the body. You can reply within
              a thread.
            </li>
            <li>
              Press <strong>⌘/Ctrl+Enter</strong> in a comment or reply box to add it (same as the
              Add button).
            </li>
          </ul>
          {token ? (
            <div className="popover__footer">
              <button type="button" className="btn btn--sm btn--danger" onClick={onClearToken}>
                Delete token
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
