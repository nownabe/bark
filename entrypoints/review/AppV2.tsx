// V2 review surface, built on the new data layer (lib/pr/).
//
// This component is intentionally separate from the legacy `App.tsx`:
// the data layer rewrite (phases 1-6b) is complete and verified by
// unit / integration tests; here we exercise it in a real React tree
// without disturbing the live extension. Subsequent phases will grow
// this UI feature-by-feature until it can replace the legacy App.
//
// The component expects a pre-bootstrapped `PullRequestRepository` and
// a `refresh()` function (see `lib/pr/bootstrap.ts`). It does not call
// `bootstrapPullRequest` itself so the auth-token / browser-storage
// integration can be supplied separately by the entrypoint.

import { useEffect, useMemo, useState } from "react";
import type { ThreadGroup } from "../../lib/pr/appstate";
import { RepositoryProvider, useAppState, useRepository } from "../../lib/pr/react";
import type { PullRequestRepository } from "../../lib/pr/repository";
import type { Comment, LocalId } from "../../lib/pr/types";
import { SnackbarProvider, useSnackbar } from "./components/Snackbar";

export type AppV2Props = {
  repository: PullRequestRepository;
  refresh: () => Promise<void>;
};

/** Top-level V2 component. Wraps children in the providers the rest of
 *  the tree needs and renders the review surface. */
export function AppV2({ repository, refresh }: AppV2Props) {
  return (
    <RepositoryProvider repo={repository}>
      <SnackbarProvider>
        <ReviewSurface refresh={refresh} />
      </SnackbarProvider>
    </RepositoryProvider>
  );
}

function ReviewSurface({ refresh }: { refresh: () => Promise<void> }) {
  // For now `isInDiff` defaults to false here; the entrypoint wires it
  // through the bootstrapped repository's `runSyncCycles` already. Once
  // we display in-diff state in the sidebar we will read it from a
  // memoised closure tied to RemoteState.
  const ctx = useMemo(() => ({ isInDiff: () => false }), []);
  const state = useAppState(ctx);
  const snackbar = useSnackbar();
  const repository = useRepository();
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } catch (e) {
      snackbar.show(`Could not refresh from GitHub. (${errMessage(e)})`);
    } finally {
      setRefreshing(false);
    }
  };

  const onSubmitDrafts = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await repository.submitDrafts();
    } catch (e) {
      snackbar.show(`Submit failed. (${errMessage(e)})`);
    } finally {
      setSubmitting(false);
    }
  };

  const onDiscardComment = async (id: LocalId) => {
    try {
      await repository.discardComment(id);
    } catch (e) {
      snackbar.show(`Discard failed. (${errMessage(e)})`);
    }
  };

  useVisibilityRefresh(onRefresh);

  const draftCount = countDrafts(state.commentViews);

  return (
    <main className="appv2">
      <header className="appv2__header">
        <PrHeading pullRequest={state.pullRequest} viewer={state.viewer} role={state.role} />
        <div className="appv2__header-actions">
          {draftCount > 0 && (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={onSubmitDrafts}
              disabled={submitting}
              data-testid="submit-drafts"
            >
              {submitting
                ? "Submitting…"
                : `Submit ${draftCount} draft${draftCount === 1 ? "" : "s"}`}
            </button>
          )}
          <button type="button" className="btn btn--sm" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {state.pullRequest && (
        <NewCommentForm
          headSha={state.pullRequest.headSha}
          viewerLogin={state.viewer?.login ?? "you"}
        />
      )}

      <section className="appv2__threads" data-testid="threads">
        <h2 className="appv2__section-title">Threads ({state.threadGroups.length})</h2>
        {state.threadGroups.length === 0 ? (
          <p className="appv2__empty">No threads yet.</p>
        ) : (
          <ul className="appv2__thread-list">
            {state.threadGroups.map((group) => (
              <ThreadItem
                key={group.thread.id}
                group={group}
                viewerLogin={state.viewer?.login ?? "you"}
                onDiscard={onDiscardComment}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/** A single thread row: the thread's metadata + its comments + the
 *  per-thread actions (Resolve / Unresolve, Reply). */
function ThreadItem({
  group,
  viewerLogin,
  onDiscard,
}: {
  group: ThreadGroup;
  viewerLogin: string;
  onDiscard: (id: LocalId) => Promise<void>;
}) {
  const repository = useRepository();
  const snackbar = useSnackbar();
  const [showReply, setShowReply] = useState(false);
  const [togglingResolve, setTogglingResolve] = useState(false);

  const thread = group.thread;
  // Resolve only makes sense once the thread exists on GitHub.
  const canToggleResolve = thread.state === "synced";

  const onToggleResolve = async () => {
    if (togglingResolve) return;
    setTogglingResolve(true);
    try {
      await repository.setThreadResolved(thread.id, !thread.resolved);
    } catch (e) {
      snackbar.show(
        `Could not ${thread.resolved ? "unresolve" : "resolve"} thread. (${errMessage(e)})`,
      );
    } finally {
      setTogglingResolve(false);
    }
  };

  return (
    <li className="appv2__thread">
      <div className="appv2__thread-head">
        <span className="appv2__thread-id">{thread.id}</span>
        {thread.resolved && <span className="appv2__badge appv2__badge--resolved">resolved</span>}
        {thread.state === "syncing" && (
          <span className="appv2__badge appv2__badge--syncing">syncing</span>
        )}
        {canToggleResolve && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={onToggleResolve}
            disabled={togglingResolve}
            data-testid={`resolve-${thread.id}`}
          >
            {togglingResolve
              ? thread.resolved
                ? "Unresolving…"
                : "Resolving…"
              : thread.resolved
                ? "Unresolve"
                : "Resolve"}
          </button>
        )}
      </div>

      <ul className="appv2__comment-list">
        {group.comments.map((view) => (
          <li key={view.comment.id} className="appv2__comment">
            <span className="appv2__author">@{view.comment.author.login}</span>
            <span className="appv2__body">{view.comment.body}</span>
            {view.isMyDraft && <span className="appv2__badge appv2__badge--draft">draft</span>}
            {view.kind === "suggestion" && (
              <span className="appv2__badge appv2__badge--suggestion">suggestion</span>
            )}
            {view.comment.lastError && (
              <span
                className="appv2__badge appv2__badge--error"
                title={view.comment.lastError.message}
              >
                error
              </span>
            )}
            {view.isMyDraft && (
              <button
                type="button"
                className="btn btn--sm btn--danger"
                onClick={() => onDiscard(view.comment.id)}
                data-testid={`discard-${view.comment.id}`}
              >
                Discard
              </button>
            )}
          </li>
        ))}
      </ul>

      {group.comments.length > 0 && (
        <div className="appv2__thread-actions">
          {!showReply ? (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setShowReply(true)}
              data-testid={`reply-${thread.id}`}
            >
              Reply
            </button>
          ) : (
            <ReplyForm
              thread={thread}
              root={group.comments[0]!.comment}
              viewerLogin={viewerLogin}
              onDone={() => setShowReply(false)}
            />
          )}
        </div>
      )}
    </li>
  );
}

/** Inline reply form. Mirrors NewCommentForm but creates a Comment with
 *  parentLocalId pointing at the thread's root, so the Reconciler emits
 *  a CreateReply (rather than a CreateComment) on submit. */
function ReplyForm({
  thread,
  root,
  viewerLogin,
  onDone,
}: {
  thread: { id: LocalId };
  root: Comment;
  viewerLogin: string;
  onDone: () => void;
}) {
  const repository = useRepository();
  const snackbar = useSnackbar();
  const [body, setBody] = useState("");

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (body.trim() === "") {
      snackbar.show("Reply body is empty.", "warning");
      return;
    }
    try {
      await repository.upsertComment({
        id: crypto.randomUUID(),
        state: "draft",
        threadId: thread.id,
        parentLocalId: root.id,
        body,
        author: { login: viewerLogin },
        path: root.path,
        anchor: root.anchor,
      });
      setBody("");
      onDone();
    } catch (e) {
      snackbar.show(`Could not create reply. (${errMessage(e)})`);
    }
  };

  return (
    <form className="appv2__reply" onSubmit={onSubmit} data-testid={`reply-form-${thread.id}`}>
      <textarea
        className="input"
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Reply…"
        data-testid={`reply-body-${thread.id}`}
      />
      <div className="appv2__reply-actions">
        <button type="submit" className="btn btn--primary btn--sm">
          Add reply draft
        </button>
        <button type="button" className="btn btn--sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Manual comment-creation form. Stand-in for the eventual
 *  selection-driven UX (CodeMirror integration) — this lets V2 exercise
 *  the create-draft → submit pipeline in real React. */
function NewCommentForm({ headSha, viewerLogin }: { headSha: string; viewerLogin: string }) {
  const repository = useRepository();
  const snackbar = useSnackbar();
  const [path, setPath] = useState("README.md");
  const [body, setBody] = useState("");
  const [sl, setSl] = useState("1");
  const [sc, setSc] = useState("1");
  const [el, setEl] = useState("1");
  const [ec, setEc] = useState("1");
  const [quote, setQuote] = useState("");

  const reset = () => {
    setBody("");
    setQuote("");
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (body.trim() === "") {
      snackbar.show("Comment body is empty.", "warning");
      return;
    }
    const threadId = crypto.randomUUID();
    const commentId = crypto.randomUUID();
    try {
      await repository.upsertThread({
        id: threadId,
        state: "draft",
        resolved: false,
      });
      await repository.upsertComment({
        id: commentId,
        state: "draft",
        threadId,
        body,
        author: { login: viewerLogin },
        path,
        anchor: {
          sha: headSha,
          range: {
            sl: Number(sl),
            sc: Number(sc),
            el: Number(el),
            ec: Number(ec),
          },
          quote,
        },
      });
      reset();
    } catch (err) {
      snackbar.show(`Could not create draft. (${errMessage(err)})`);
    }
  };

  return (
    <form className="appv2__new-comment" onSubmit={onSubmit} data-testid="new-comment-form">
      <h2 className="appv2__section-title">New comment</h2>
      <label className="appv2__field">
        <span>Path</span>
        <input
          className="input"
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
      </label>
      <div className="appv2__range">
        <label className="appv2__field appv2__field--narrow">
          <span>sl</span>
          <input
            className="input"
            type="number"
            min="1"
            value={sl}
            onChange={(e) => setSl(e.target.value)}
          />
        </label>
        <label className="appv2__field appv2__field--narrow">
          <span>sc</span>
          <input
            className="input"
            type="number"
            min="1"
            value={sc}
            onChange={(e) => setSc(e.target.value)}
          />
        </label>
        <label className="appv2__field appv2__field--narrow">
          <span>el</span>
          <input
            className="input"
            type="number"
            min="1"
            value={el}
            onChange={(e) => setEl(e.target.value)}
          />
        </label>
        <label className="appv2__field appv2__field--narrow">
          <span>ec</span>
          <input
            className="input"
            type="number"
            min="1"
            value={ec}
            onChange={(e) => setEc(e.target.value)}
          />
        </label>
      </div>
      <label className="appv2__field">
        <span>Quote</span>
        <input
          className="input"
          type="text"
          value={quote}
          onChange={(e) => setQuote(e.target.value)}
        />
      </label>
      <label className="appv2__field">
        <span>Body</span>
        <textarea
          className="input"
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          data-testid="new-comment-body"
        />
      </label>
      <button type="submit" className="btn btn--primary btn--sm">
        Add draft
      </button>
    </form>
  );
}

function PrHeading({
  pullRequest,
  viewer,
  role,
}: {
  pullRequest: ReturnType<typeof useAppState>["pullRequest"];
  viewer: ReturnType<typeof useAppState>["viewer"];
  role: ReturnType<typeof useAppState>["role"];
}) {
  if (!pullRequest) {
    return <p className="appv2__loading">Loading PR…</p>;
  }
  return (
    <div className="appv2__pr-heading">
      <h1 className="appv2__title">{pullRequest.title}</h1>
      <p className="appv2__meta">
        <span>
          {pullRequest.owner}/{pullRequest.repo}#{pullRequest.number}
        </span>
        {viewer && (
          <>
            {" · "}
            <span>
              viewer @{viewer.login} ({role ?? "—"})
            </span>
          </>
        )}
      </p>
    </div>
  );
}

function countDrafts(views: Map<LocalId, { comment: Comment }>): number {
  let n = 0;
  for (const v of views.values()) {
    if (v.comment.state === "draft") n++;
  }
  return n;
}

const VISIBILITY_THRESHOLD_MS = 30_000;

function useVisibilityRefresh(onRefresh: () => Promise<void>) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    let hiddenAt = 0;
    const handle = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
      } else if (document.visibilityState === "visible" && hiddenAt > 0) {
        if (Date.now() - hiddenAt >= VISIBILITY_THRESHOLD_MS) {
          void onRefresh();
        }
        hiddenAt = 0;
      }
    };
    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, [onRefresh]);
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
