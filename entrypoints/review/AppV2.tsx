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

import { markdown } from "@codemirror/lang-markdown";
import CodeMirror, { type ViewUpdate } from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ThreadGroup } from "../../lib/pr/appstate";
import { RepositoryProvider, useAppState, useRepository } from "../../lib/pr/react";
import type { PullRequestRepository } from "../../lib/pr/repository";
import type { Comment, FileContent, LocalId } from "../../lib/pr/types";
import { SnackbarProvider, useSnackbar } from "./components/Snackbar";
import { useVisibilityRefresh } from "./hooks/useVisibilityRefresh";

/** Live editor selection — sufficient to construct a Comment.anchor. */
export type EditorSelection = {
  path: string;
  sl: number;
  sc: number;
  el: number;
  ec: number;
  quote: string;
};

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
  const state = useAppState();
  const snackbar = useSnackbar();
  const repository = useRepository();
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selection, setSelection] = useState<EditorSelection | null>(null);

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
        <SourceViewer currentFiles={state.currentFiles} onSelectionChange={setSelection} />
      )}

      {state.pullRequest && (
        <NewCommentForm
          headSha={state.pullRequest.headSha}
          viewerLogin={state.viewer?.login ?? "you"}
          selection={selection}
          onClearSelection={() => setSelection(null)}
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
            <span className="appv2__location" data-testid={`location-${view.comment.id}`}>
              {view.comment.path
                ? `${view.comment.path}:L${view.comment.anchor.range.sl}`
                : "(no file)"}
            </span>
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

/** CodeMirror-backed source viewer (read-only). Reads the currently-
 *  available files from AppState (`currentFiles`, already scoped to the
 *  PR's head SHA and sorted), lets the viewer pick one, shows the source
 *  with Markdown syntax highlighting, and reports selection changes
 *  upward so the comment form can pick them up.
 *
 *  Layered architecture: this component never reaches into Repository or
 *  RemoteState — it receives a derived snapshot from its parent. */
function SourceViewer({
  currentFiles,
  onSelectionChange,
}: {
  currentFiles: FileContent[];
  onSelectionChange: (selection: EditorSelection | null) => void;
}) {
  const availablePaths = useMemo(() => currentFiles.map((f) => f.path), [currentFiles]);

  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const selected =
    currentPath !== null && availablePaths.includes(currentPath)
      ? currentPath
      : (availablePaths[0] ?? null);

  const source = useMemo(() => {
    if (selected === null) return null;
    return currentFiles.find((f) => f.path === selected)?.source ?? null;
  }, [currentFiles, selected]);

  // Clear the parent's captured selection whenever the active path
  // changes, because the anchor would refer to a different file.
  useEffect(() => {
    onSelectionChange(null);
  }, [selected, onSelectionChange]);

  const onUpdate = useCallback(
    (vu: ViewUpdate) => {
      if (!vu.selectionSet || selected === null) return;
      const sel = vu.state.selection.main;
      if (sel.from === sel.to) {
        onSelectionChange(null);
        return;
      }
      const quote = vu.state.doc.sliceString(sel.from, sel.to);
      const startLine = vu.state.doc.lineAt(sel.from);
      const endLine = vu.state.doc.lineAt(sel.to);
      onSelectionChange({
        path: selected,
        sl: startLine.number,
        sc: sel.from - startLine.from + 1,
        el: endLine.number,
        ec: sel.to - endLine.from + 1,
        quote,
      });
    },
    [selected, onSelectionChange],
  );

  if (availablePaths.length === 0) {
    return (
      <section className="appv2__source" data-testid="source-viewer">
        <h2 className="appv2__section-title">Source</h2>
        <p className="appv2__empty">No file content loaded yet.</p>
      </section>
    );
  }

  return (
    <section className="appv2__source" data-testid="source-viewer">
      <div className="appv2__source-head">
        <h2 className="appv2__section-title">Source</h2>
        {availablePaths.length > 1 && (
          <select
            className="input"
            value={selected ?? ""}
            onChange={(e) => setCurrentPath(e.target.value)}
            data-testid="source-path"
          >
            {availablePaths.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="appv2__editor" data-testid="source-editor">
        {source !== null ? (
          <CodeMirror
            value={source}
            editable={false}
            extensions={MARKDOWN_EXTENSIONS}
            onUpdate={onUpdate}
            basicSetup={CM_BASIC_SETUP}
          />
        ) : (
          <p className="appv2__empty">Could not load source.</p>
        )}
      </div>
    </section>
  );
}

const MARKDOWN_EXTENSIONS = [markdown()];
const CM_BASIC_SETUP = {
  lineNumbers: true,
  highlightActiveLine: false,
  foldGutter: false,
};

/** Comment-creation form. When a live editor selection is provided, the
 *  form uses it as the anchor; otherwise it falls back to manual entry
 *  for path / range / quote. The body is always typed by the user. */
function NewCommentForm({
  headSha,
  viewerLogin,
  selection,
  onClearSelection,
}: {
  headSha: string;
  viewerLogin: string;
  selection: EditorSelection | null;
  onClearSelection: () => void;
}) {
  const repository = useRepository();
  const snackbar = useSnackbar();
  const [path, setPath] = useState("README.md");
  const [body, setBody] = useState("");
  const [sl, setSl] = useState("1");
  const [sc, setSc] = useState("1");
  const [el, setEl] = useState("1");
  const [ec, setEc] = useState("1");
  const [quote, setQuote] = useState("");

  const usingSelection = selection !== null;

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (body.trim() === "") {
      snackbar.show("Comment body is empty.", "warning");
      return;
    }
    const threadId = crypto.randomUUID();
    const commentId = crypto.randomUUID();
    const anchor = usingSelection
      ? {
          sha: headSha,
          range: { sl: selection.sl, sc: selection.sc, el: selection.el, ec: selection.ec },
          quote: selection.quote,
        }
      : {
          sha: headSha,
          range: { sl: Number(sl), sc: Number(sc), el: Number(el), ec: Number(ec) },
          quote,
        };
    const commentPath = usingSelection ? selection.path : path;
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
        path: commentPath,
        anchor,
      });
      setBody("");
      if (usingSelection) onClearSelection();
      else setQuote("");
    } catch (err) {
      snackbar.show(`Could not create draft. (${errMessage(err)})`);
    }
  };

  return (
    <form className="appv2__new-comment" onSubmit={onSubmit} data-testid="new-comment-form">
      <h2 className="appv2__section-title">New comment</h2>
      {usingSelection ? (
        <div className="appv2__selection" data-testid="selection-banner">
          <span>
            Selection on <strong>{selection.path}</strong> L{selection.sl}:{selection.sc}–L
            {selection.el}:{selection.ec}
          </span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={onClearSelection}
            data-testid="clear-selection"
          >
            Clear
          </button>
        </div>
      ) : (
        <>
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
        </>
      )}
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

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
