// One thread in the review sidebar: its quote, its messages (submitted
// comments + pending drafts), and the row-level actions (Resolve/Reopen,
// author Accept/Reject on a suggestion root, and the reply composer).
//
// Presentation only. Every decision that needs App state — whether the
// thread can be resolved, whether an accept is safe, the root's anchor
// badge — is computed by the parent and passed in as a plain value, so
// this component stays unit-testable without a Repository or CodeMirror.

import type { ReactNode } from "react";
import type { ExistingComment } from "../../../lib/comments";
import type { PendingDraft, SuggestionDecision } from "../../../lib/drafts";
import { avatarUrl } from "../../../lib/github";
import { extractSuggestionBlock, stripSuggestionBlock } from "../../../lib/suggest";
import type { AnchorStatus } from "../adapters/displayPositionToAnchorStatus";
import { isSubmitChord } from "../keys";
import type { ReviewThread, Role } from "../reviewItems";
import { STATUS_LABEL } from "../uiHelpers";
import { SuggestionDiff } from "./SuggestionDiff";

export type ThreadItemProps = {
  thread: ReviewThread;
  /** Anchor-status badge for the root comment (null when not applicable). */
  rootStatus: AnchorStatus | null;
  role: Role;
  /** The thread has a remote identity on GitHub (review thread or Bark
   *  out-of-diff root) and may be resolved/reopened. */
  canResolve: boolean;
  /** The author may safely apply the root suggestion (reanchored, quote matches). */
  canAccept: boolean;
  /** The author's decision on the root suggestion, if any. */
  decision: SuggestionDecision | undefined;
  /** A resolve/reopen is in flight for this thread. */
  isResolving: boolean;
  emphasized: boolean;
  replyOpen: boolean;
  replyText: string;
  onOpen: () => void;
  onToggleResolve: () => void;
  onAccept: () => void;
  onReject: () => void;
  onAddReply: () => void;
  onCancelReply: () => void;
  onReplyTextChange: (value: string) => void;
  onRemoveDraft: (cid: string) => void;
};

function SubmittedMessage({
  comment,
  isRoot,
  status,
  actions,
}: {
  comment: ExistingComment;
  isRoot: boolean;
  status: AnchorStatus | null;
  actions?: ReactNode;
}) {
  return (
    <div key={`s-${comment.source}-${comment.id}`} className="comment">
      <div className="comment__meta">
        <img
          className="comment__avatar"
          src={avatarUrl(comment.author, 40)}
          alt=""
          width={18}
          height={18}
          loading="lazy"
        />
        <span className="comment__author">{comment.author}</span>
        {isRoot && status && STATUS_LABEL[status] ? (
          <span className={`badge badge--${status}`}>{STATUS_LABEL[status]}</span>
        ) : null}
        {isRoot && !comment.meta ? (
          <span className="badge badge--issue">
            {comment.line ? `L${comment.line}` : "no anchor"}
          </span>
        ) : null}
        {actions ? <span className="comment__meta-actions">{actions}</span> : null}
      </div>
      {comment.meta?.kind === "suggestion" ? (
        <>
          {stripSuggestionBlock(comment.body) ? (
            <div className="comment__body">{stripSuggestionBlock(comment.body)}</div>
          ) : null}
          <SuggestionDiff
            before={comment.meta.quote ?? ""}
            after={extractSuggestionBlock(comment.body) ?? ""}
          />
        </>
      ) : (
        <div className="comment__body">{comment.body || "(no body)"}</div>
      )}
    </div>
  );
}

function PendingMessage({
  draft,
  onRemove,
}: {
  draft: PendingDraft;
  onRemove: (cid: string) => void;
}) {
  return (
    <div key={`p-${draft.cid}`} className="comment comment--pending">
      <div className="comment__meta">
        <span className="comment__author">You</span>
        <span className="badge badge--pending">pending</span>
        <button
          type="button"
          className="btn-x"
          aria-label="Delete pending item"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(draft.cid);
          }}
        >
          ✕
        </button>
      </div>
      {draft.kind === "suggestion" ? (
        <SuggestionDiff before={draft.quote} after={draft.suggestion ?? ""} />
      ) : (
        <div className="comment__body">{draft.body || "(no body)"}</div>
      )}
      {draft.lastError ? (
        <div className="comment__body notice--error">{draft.lastError}</div>
      ) : null}
    </div>
  );
}

export function ThreadItem(props: ThreadItemProps) {
  const {
    thread: t,
    rootStatus,
    role,
    canResolve,
    canAccept,
    decision,
    isResolving,
    emphasized,
    replyOpen,
    replyText,
    onOpen,
    onToggleResolve,
    onAccept,
    onReject,
    onAddReply,
    onCancelReply,
    onReplyTextChange,
    onRemoveDraft,
  } = props;
  const root = t.rootComment;
  const showAuthorActions = root?.meta?.kind === "suggestion" && role === "author";

  const resolveAction = canResolve ? (
    <button
      type="button"
      className="thread__resolve"
      disabled={isResolving}
      onClick={(e) => {
        e.stopPropagation();
        onToggleResolve();
      }}
    >
      {isResolving
        ? t.resolved
          ? "Reopening…"
          : "Resolving…"
        : t.resolved
          ? "Reopen"
          : "✓ Resolve"}
    </button>
  ) : null;

  return (
    <div
      key={t.id}
      data-thread-id={t.id}
      className={`thread thread--clickable${t.resolved ? " thread--resolved" : ""}${
        emphasized ? " thread--emphasized" : ""
      }`}
      onClick={onOpen}
    >
      {t.quote ? <div className="thread__quote">{t.quote}</div> : null}
      {t.messages.map((m) =>
        m.kind === "submitted" ? (
          <SubmittedMessage
            key={`s-${m.comment.source}-${m.comment.id}`}
            comment={m.comment}
            isRoot={m.comment === root}
            status={rootStatus}
            actions={m.comment === root ? resolveAction : undefined}
          />
        ) : (
          <PendingMessage key={`p-${m.draft.cid}`} draft={m.draft} onRemove={onRemoveDraft} />
        ),
      )}
      {showAuthorActions && root ? (
        <div className="comment__actions" onClick={(e) => e.stopPropagation()}>
          {decision ? (
            <span className="notice--muted" style={{ fontSize: 11 }}>
              {decision === "accepted" ? "accepted — Submit to apply" : "rejected"}
            </span>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={!canAccept}
                title={
                  canAccept
                    ? undefined
                    : "The document changed since this suggestion was written — its target text can't be safely replaced."
                }
                onClick={onAccept}
              >
                Accept
              </button>
              <button type="button" className="btn btn--sm" onClick={onReject}>
                Reject
              </button>
            </>
          )}
        </div>
      ) : null}
      {replyOpen ? (
        <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
          <textarea
            className="field"
            value={replyText}
            onChange={(e) => onReplyTextChange(e.target.value)}
            onKeyDown={(e) => {
              if (isSubmitChord(e)) {
                e.preventDefault();
                onAddReply();
              }
            }}
            rows={2}
            placeholder="Reply"
            autoFocus
          />
          <div className="composer__row">
            <button type="button" className="btn btn--primary btn--sm" onClick={onAddReply}>
              Add
            </button>
            <button type="button" className="btn btn--sm" onClick={onCancelReply}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
