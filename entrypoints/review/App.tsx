// SPA shell.
// The document surface is CodeMirror 6 (always editable, source canonical),
// Obsidian-style Raw/Preview. Controls live in a sticky header; comments are
// position-sorted and threaded; debug info is collapsible.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";
import { EditorView } from "@codemirror/view";
import {
  handleSelectionUpdate,
  cmSelectionToAnchor,
  bubbleAnchorPoint,
  type BubblePos,
} from "./cmAnchor";
import { commentHighlightField, commentHighlightTheme, setCommentHighlights } from "./highlight";
import { richMarkdown, richMarkdownTheme } from "./richMarkdown";
import { baseTextField, setBaseText, suggestDecorations, suggestTheme } from "./suggestMode";
import { setSuggestionMarks, suggestionMarksField, suggestionViewTheme } from "./suggestionView";
import { SelectionBubble } from "./components/SelectionBubble";
import { LoginGate } from "./components/LoginGate";
import { SuggestionDiff } from "./components/SuggestionDiff";
import { Topbar } from "./components/Topbar";
import { ReviewSidebar } from "./components/ReviewSidebar";
import { SourceEditor } from "./components/SourceEditor";
import { InstallGate } from "./components/InstallGate";
import { DebugFab } from "./components/DebugFab";
import { RoleFab } from "./components/RoleFab";
import { SubmitConfirmModal } from "./components/SubmitConfirmModal";
import { DiscardAllConfirmModal } from "./components/DiscardAllConfirmModal";
import { ThreadItem } from "./components/ThreadItem";
import {
  buildAllPendingSuggestions,
  buildAuthorPendingItems,
  buildPendingItems,
  buildPendingSuggestions,
  buildReviewEntries,
  buildSuggestionMarks,
  buildThreads,
  canReplyToThread,
  deriveRole,
  filterReviewEntries,
  replyAnchor,
  revealSubmittedFacets,
  reviewEntryCounts,
  threadRangeAt,
  type AcceptedSuggestionInfo,
  type PendingSuggestion,
  type ReviewFacet,
  type ReviewThread,
  type Role,
  type ThreadRange,
} from "./reviewItems";
import {
  applyAcceptedSuggestion,
  diffToSuggestions,
  extractSuggestionBlock,
  isMeaningfulEdit,
  rebaseLoadedEdit,
  suggestionEditRanges,
} from "../../lib/suggest";
import { buildLineIndex, lineColToOffset, type SourceAnchor } from "../../lib/anchor";
import type { ExistingComment } from "../../lib/comments";
import {
  buildBlobPermalink,
  buildSuggestionBlock,
  pullStatus,
  type PrRef,
  type PullInfo,
} from "../../lib/github";
import { GitHubApiError } from "../../lib/pr/github-api";
import { fetchFileContent } from "../../lib/pr/remote-fetcher";
import { type FileEdit, hasRemoteIdentity } from "../../lib/pr/types";
import { type ChangedFile, isRangeInDiff, parseRightRanges } from "../../lib/pr/diff";
import {
  clearAcceptedDecisions,
  listSuggestionEdits,
  saveSuggestionEdits,
  type PendingDraft,
  type SuggestionDecision,
} from "../../lib/drafts";
import { embedMetadata, extractMetadata, type CommentMetadata } from "../../lib/metadata";
import { browser } from "wxt/browser";
import { bootstrapPullRequest } from "../../lib/pr/bootstrap";
import type { PullRequestRepository } from "../../lib/pr/repository";
import { useAppStateFromRepository } from "../../lib/pr/react";
import type { CommentView } from "../../lib/pr/appstate";
import { commentViewsToExisting } from "./adapters/commentViewsToExisting";
import {
  type AnchorStatus,
  displayPositionToAnchorStatus,
} from "./adapters/displayPositionToAnchorStatus";
import { pendingDraftToComment } from "./adapters/pendingDraftToComment";
import { useAuthFlow } from "./hooks/useAuthFlow";
import { productionAuthDeps } from "./hooks/useAuthFlow.deps";
import { useSuggestionEdits } from "./hooks/useSuggestionEdits";
import { productionSuggestionEditsDeps } from "./hooks/useSuggestionEdits.deps";
import { useDismissedSuggestions } from "./hooks/useDismissedSuggestions";
import { productionDismissedDeps } from "./hooks/useDismissedSuggestions.deps";
import { useSelectedFileContent } from "./hooks/useSelectedFileContent";
import { useUiPanels } from "./hooks/useUiPanels";
import { useThreadActions } from "./hooks/useThreadActions";
import { useVisibilityRefresh } from "./hooks/useVisibilityRefresh";
import { SnackbarProvider, useSnackbar } from "./components/Snackbar";
import { sampleDoc } from "./sample";
import {
  canAcceptSuggestion,
  DEV_ROLE_SWITCH,
  errMessage,
  installUrl,
  type ViewMode,
} from "./uiHelpers";

/** Stable empty file list for renders before AppState exists. */
const NO_FILES: ChangedFile[] = [];

/** Whether an upsert of `next` would change anything. */
function sameFileEdit(current: FileEdit | undefined, next: FileEdit): boolean {
  return (
    current !== undefined &&
    current.state === next.state &&
    current.path === next.path &&
    current.baseSha === next.baseSha &&
    current.editedSource === next.editedSource &&
    (current.resolveOnCommit ?? []).join("\0") === (next.resolveOnCommit ?? []).join("\0")
  );
}

/** The review surface wrapped in its global error channel: every
 *  user-relevant error is announced via the Snackbar (ADR 0005 §4), so
 *  AppBody must sit under the provider to call useSnackbar. */
export function App() {
  return (
    <SnackbarProvider>
      <AppBody />
    </SnackbarProvider>
  );
}

function AppBody() {
  const params = new URLSearchParams(window.location.search);
  const owner = params.get("owner");
  const repo = params.get("repo");
  const prNum = params.get("pr");
  // The query string is untrusted: a NaN, fractional or non-positive `pr`
  // would flow into API paths and storage keys, so it never becomes a PrRef
  // and is reported instead of loaded (issue #295).
  const prNumber = Number(prNum);
  const prNumberValid = Number.isInteger(prNumber) && prNumber > 0;
  const ref: PrRef | null =
    owner && repo && prNum && prNumberValid ? { owner, repo, number: prNumber } : null;

  const auth = useAuthFlow(productionAuthDeps);
  const {
    token,
    authMethod,
    tokenLoaded,
    deviceAuth,
    authStarting,
    authError,
    startDeviceFlow,
    completeAuth,
    clearToken: clearAuthToken,
  } = auth;
  // New-layer GitHub client (lib/pr/github-api): a plain token-carrying
  // object consumed by the remote-fetcher functions — same shape the
  // Repository bootstrap builds internally, so all GETs share one ETag
  // cache and retry policy.
  const client = useMemo(() => (token ? { token } : null), [token]);

  // ---- PR load lifecycle --------------------------------------------------
  // The Repository bootstrap IS the initial PR load: these flags wrap the
  // bootstrap effect below, and the submit/save flows further down reuse the
  // same loading/error surface.
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsInstall, setNeedsInstall] = useState(false);
  // Global error surface (ADR 0005 §4): the Snackbar is ALWAYS used for a
  // user-relevant error; the persistent inline notice stays as the
  // additional in-context reflection the same policy allows. `show` is
  // referentially stable, so reportError is too.
  const { show: showSnackbar } = useSnackbar();
  const reportError = useCallback(
    (msg: string) => {
      setError(msg);
      showSnackbar(msg);
    },
    [showSnackbar],
  );
  // Bumping re-runs the bootstrap effect (the "Retry" affordance).
  const [bootKey, setBootKey] = useState(0);
  const retryLoad = () => setBootKey((k) => k + 1);

  // New data layer (lib/pr/): bootstrap a Repository as soon as we have a
  // token + PR ref. Everything the surface renders — PR metadata, viewer,
  // the changed-.md selector, comment/thread views — derives from its
  // AppState below (ADR 0001 §4: React reads AppState).
  const [prRepository, setPrRepository] = useState<PullRequestRepository | null>(null);
  // Full-refresh function from the bootstrap; drives the ADR 0005 §1
  // triggers below (visibility change, debug button). Null until bootstrap
  // resolves and after logout.
  const [refreshPr, setRefreshPr] = useState<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (!token || !ref) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNeedsInstall(false);
    void (async () => {
      try {
        const { repository, refresh } = await bootstrapPullRequest({
          token,
          prRef: ref,
          storage: browser.storage.local,
          onPersistError: (e) => reportError(errMessage(e)),
        });
        if (!cancelled) {
          setPrRepository(repository);
          setRefreshPr(() => refresh);
        }
      } catch (e) {
        if (cancelled) return;
        reportError(errMessage(e));
        // A 404/403 on the PR load usually means the GitHub App is not
        // installed on this repo — offer the install screen.
        setNeedsInstall(e instanceof GitHubApiError && (e.status === 404 || e.status === 403));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, ref?.owner, ref?.repo, ref?.number, bootKey]);

  // Error-wrapped full refresh shared by the ADR 0005 triggers below
  // (visibility change §1, debug button §5). A refresh failure keeps the
  // previous RemoteState (bootstrap's refresh replaces it only on success);
  // surface the reason and let the next trigger retry (§4).
  const safeRefresh = useMemo(
    () =>
      refreshPr &&
      (async () => {
        try {
          await refreshPr();
        } catch (e) {
          reportError(errMessage(e));
        }
      }),
    [refreshPr],
  );
  useVisibilityRefresh(safeRefresh);

  const repositoryAppState = useAppStateFromRepository(prRepository);
  const pullRequest = repositoryAppState?.pullRequest ?? null;
  // Legacy PullInfo shape for Topbar & friends (author flattened to login).
  const pull = useMemo<PullInfo | null>(
    () =>
      pullRequest && {
        headSha: pullRequest.headSha,
        headRef: pullRequest.headRef,
        title: pullRequest.title,
        body: pullRequest.body,
        author: pullRequest.author.login,
        state: pullRequest.state,
        draft: pullRequest.draft,
        merged: pullRequest.merged,
      },
    [pullRequest],
  );
  const files = repositoryAppState?.changedMarkdownFiles ?? NO_FILES;
  // headSha advances automatically when a commit lands: the Executor's
  // apply step writes the new head into RemoteState.pullRequest and the
  // subscription re-derives (no manual setHeadSha anywhere).
  const headSha = pullRequest?.headSha ?? null;
  const headRef = pullRequest?.headRef ?? null;
  const viewerLogin = repositoryAppState?.viewer?.login ?? null;

  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const [role, setRole] = useState<Role>("reviewer");
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  // The open composer's anchor — set only when the selection bubble is clicked.
  const [anchor, setAnchor] = useState<SourceAnchor | null>(null);
  // The pending text selection (drives the bubble button, not the composer) and
  // the bubble's viewport position. Cleared when the selection collapses or the
  // composer opens.
  const [selection, setSelection] = useState<SourceAnchor | null>(null);
  const [bubblePos, setBubblePos] = useState<BubblePos | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const dismissedApi = useDismissedSuggestions(ref, productionDismissedDeps);
  const { dismissed, setDismissed, setDecision, reset: resetDismissed } = dismissedApi;
  const threadActions = useThreadActions();
  const {
    replyTo,
    replyText,
    setReplyText,
    startReply,
    cancelReply,
    emphasizedThreadId,
    setEmphasizedThreadId,
    clearEmphasis,
    resolvingId,
    setResolvingId,
  } = threadActions;
  const suggestionEditsApi = useSuggestionEdits(ref, {
    ...productionSuggestionEditsDeps,
    onSaveError: (e) => reportError(errMessage(e)),
  });
  const {
    suggestionEdits,
    suggestionComments,
    setSuggestionEdits,
    setSuggestionComments,
    persistSuggestionEdit,
    flushPendingWrites: flushSuggestionEdits,
    discardAllPersisted: discardAllPersistedEdits,
    reset: resetSuggestionEdits,
  } = suggestionEditsApi;
  const fileSourceApi = useSelectedFileContent(
    client,
    ref,
    headSha,
    selectedPath,
    ref ? "" : sampleDoc,
    { listSuggestionEdits },
    {
      onLoadingChange: setLoading,
      onError: reportError,
      onLoaded: ({ path, text, edit }) => {
        setSuggestionComments(edit?.comments ?? {});
        if (!edit) return;
        // Reconcile the persisted edit with the freshly-fetched base. If the
        // file changed upstream, re-apply the author's edits onto the new
        // base (3-way rebase) — the recovery path after a #187 commit
        // conflict. A dirty merge keeps the edit anchored to its old base so
        // the commit pipeline keeps refusing it instead of dropping hunks.
        const result = rebaseLoadedEdit(edit, text, headSha ?? "");
        setSuggestionEdits((prev) => ({ ...prev, [path]: result.edit }));
        if (result.status === "rebased") {
          setSource(result.edit.source);
        } else if (result.status === "conflict") {
          reportError(
            `${path} changed upstream and your edits could not be merged automatically. ` +
              `Review your version in the editor, or use "Discard edits" and re-apply them ` +
              `on the latest content.`,
          );
        }
      },
      onCleanup: () => {
        // Persist any pending edit before switching files / unmounting
        // so a quick reload right after an edit still restores it.
        void flushSuggestionEdits();
      },
    },
  );
  const { source, baseSource, ready: fileReady, setSource, setBaseSource } = fileSourceApi;
  const [reviewFilter, setReviewFilter] = useState<Set<ReviewFacet>>(
    () => new Set<ReviewFacet>(["pending", "submitted"]),
  );
  const uiPanels = useUiPanels();
  const {
    showSubmitConfirm,
    setShowSubmitConfirm,
    showDiscardConfirm,
    setShowDiscardConfirm,
    showPrInfo,
    togglePrInfo,
    prInfoBtnRef,
    prInfoRef,
    showHelp,
    toggleHelp,
    closeHelp,
    helpBtnRef,
    helpRef,
    showDebug,
    toggleDebug,
    closeDebug,
  } = uiPanels;
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  // The pending-suggestion ids seen on the previous render, so a newly created
  // suggestion can be scrolled into view in the review list (see effect below).
  const seenSuggestionCids = useRef<Set<string>>(new Set());
  // Per-path suggestion edits awaiting a debounced write to storage (so pending
  // (Debounced per-path persist buffer + timer live in useSuggestionEdits now.)
  // Set before a programmatic "jump to item" selection so the resulting
  // selection update does not pop the new-comment composer (we are highlighting
  // an existing item, not starting a new comment).
  const suppressNextAnchor = useRef(false);

  // CommentView lookup by GitHub REST id — used by statusFor (L5) so it
  // can read the new layer's displayPosition instead of running legacy
  // reanchorComment on its own.
  const commentViewByRemoteId = useMemo(() => {
    const out = new Map<number, CommentView>();
    if (!repositoryAppState) return out;
    for (const v of repositoryAppState.commentViews.values()) {
      if (v.comment.remoteId !== undefined) out.set(v.comment.remoteId, v);
    }
    return out;
  }, [repositoryAppState]);
  // CommentView lookup by cid (Bark-authored Comment.id). Used by the
  // editor-highlight / thread-range / jumpTo paths to read each Bark
  // comment's reanchored displayPosition (ADR 0004) without re-running
  // the legacy reanchorComment inline.
  const commentViewByCid = useMemo(() => {
    const out = new Map<string, CommentView>();
    if (!repositoryAppState) return out;
    for (const v of repositoryAppState.commentViews.values()) {
      out.set(v.comment.id, v);
    }
    return out;
  }, [repositoryAppState]);
  // Comments now come entirely from the Repository's AppState. CommentViews
  // carries Bark-authored synced comments (via LocalState) and foreign comments
  // (via RemoteState). The downstream reviewItems pipeline filters out C/D
  // (foreign issue / out-of-diff review) since Bark's scope is line-bound
  // markdown review.
  const comments = useMemo<ExistingComment[]>(() => {
    if (!repositoryAppState) return [];
    return commentViewsToExisting(repositoryAppState.commentViews.values());
  }, [repositoryAppState]);
  // The sidebar's thread keys equal the data layer's Thread ids: Bark
  // comments group by their metadata threadId, foreign comments by their
  // threadKey (both == Comment.threadId == Thread.id), so Repository
  // Thread-id sets can be consumed directly — no key mapping needed.
  const resolvedThreadKeys = useMemo(() => {
    if (!prRepository || !repositoryAppState) return new Set<string>();
    return new Set(
      prRepository
        .getLocalState()
        .threads.filter((t) => t.resolved)
        .map((t) => t.id),
    );
  }, [prRepository, repositoryAppState]);
  // Threads that can actually be resolved/reopened: they exist on GitHub
  // with a remote identity — a review thread (GraphQL) or an out-of-diff
  // thread whose root issue comment carries Bark metadata (issue #270). A
  // thread created in this session gets its identity from the step result
  // that posted it (issue #272); a foreign issue comment never gets one.
  const resolvableThreadKeys = useMemo(() => {
    if (!prRepository || !repositoryAppState) return new Set<string>();
    return new Set(
      prRepository
        .getLocalState()
        .threads.filter(hasRemoteIdentity)
        .map((t) => t.id),
    );
  }, [prRepository, repositoryAppState]);

  const lineStarts = useMemo(() => buildLineIndex(source), [source]);
  const diffRanges = useMemo(
    () => parseRightRanges(files.find((f) => f.path === selectedPath)?.patch),
    [files, selectedPath],
  );
  // Per-file diff ranges; the drafts derivation below uses this to compute
  // each draft's inDiff at display time (rather than persisting the bit on
  // the Comment, which has no such field).
  const diffRangesByPath = useMemo(() => {
    const out = new Map<string, ReturnType<typeof parseRightRanges>>();
    for (const f of files) if (f.patch) out.set(f.path, parseRightRanges(f.patch));
    return out;
  }, [files]);
  // Drafts derived from Repository LocalState (Comment.state === "draft").
  // The PendingDraft shape's derivable fields:
  //   - inDiff: from diffRangesByPath + anchor range
  //   - permalink: rebuilt for out-of-diff drafts
  //   - kind: always "comment" — suggestion-typed drafts are transient (built
  //     by suggestionsToDrafts at submit time only).
  const drafts = useMemo<PendingDraft[]>(() => {
    if (!repositoryAppState || !ref) return [];
    const out: PendingDraft[] = [];
    for (const v of repositoryAppState.commentViews.values()) {
      const c = v.comment;
      if (c.state !== "draft") continue;
      const ranges = diffRangesByPath.get(c.path);
      const inDiff = ranges ? isRangeInDiff(ranges, c.anchor.range.sl, c.anchor.range.el) : false;
      out.push({
        cid: c.id,
        path: c.path,
        inDiff,
        range: c.anchor.range,
        quote: c.anchor.quote,
        sha: c.anchor.sha,
        thread: c.threadId,
        body: c.body,
        kind: "comment",
        lastError: c.lastError?.message,
        permalink:
          !inDiff && c.anchor.sha
            ? buildBlobPermalink(ref, c.path, c.anchor.sha, c.anchor.range.sl, c.anchor.range.el)
            : undefined,
      });
    }
    return out;
  }, [repositoryAppState, diffRangesByPath, ref]);
  const suggestionHunks = useMemo(
    () =>
      role === "reviewer" && source !== baseSource ? diffToSuggestions(baseSource, source) : [],
    [role, source, baseSource],
  );
  const cmExtensions = useMemo(() => {
    const ext = [
      markdown({ extensions: [GFM], codeLanguages: languages }),
      EditorView.lineWrapping,
      commentHighlightField,
      commentHighlightTheme,
      suggestionMarksField,
      suggestionViewTheme,
      baseTextField,
    ];
    if (viewMode === "preview") ext.push(richMarkdown, richMarkdownTheme);
    if (role === "reviewer") ext.push(suggestDecorations, suggestTheme);
    // While the selected file's content is loading, `source` still holds
    // the previous file's text — keep the editor read-only so a keystroke
    // can't persist that text under the new path (issue #185).
    if (!fileReady) ext.push(EditorView.editable.of(false));
    return ext;
  }, [viewMode, role, fileReady]);

  const curPath = selectedPath ?? "sample";

  // The reviewer's live editor edits are surfaced as pending suggestions the
  // moment they are made; each carries its own attached comment.
  const pendingSuggestions = useMemo<PendingSuggestion[]>(() => {
    if (role !== "reviewer") return [];
    return buildPendingSuggestions(suggestionHunks, {
      path: curPath,
      isInDiff: (sl, el) => isRangeInDiff(diffRanges, sl, el),
      commentFor: (cid) => suggestionComments[cid] ?? "",
    });
  }, [role, suggestionHunks, curPath, suggestionComments, diffRanges]);

  // Pending suggestions across ALL files (every persisted edit), for the submit
  // scope — the button count, the confirm modal, and submit itself span all
  // files, unlike the per-file `pendingSuggestions` used by the sidebar.
  const allPendingSuggestions = useMemo<PendingSuggestion[]>(() => {
    if (role !== "reviewer") return [];
    return buildAllPendingSuggestions(suggestionEdits, (path, sl, el) =>
      isRangeInDiff(parseRightRanges(files.find((f) => f.path === path)?.patch), sl, el),
    );
  }, [role, suggestionEdits, files]);

  // Threads (submitted comments + pending replies merged) + live suggestions,
  // in one sorted list.
  const threads = useMemo(
    () =>
      buildThreads(comments, drafts, curPath, {
        accepted: (id) => dismissed[id] === "accepted",
        resolvedKeys: resolvedThreadKeys,
      }),
    [comments, drafts, curPath, dismissed, resolvedThreadKeys],
  );
  const entries = useMemo(
    () => buildReviewEntries({ threads, pendingSuggestions, currentPath: curPath }),
    [threads, pendingSuggestions, curPath],
  );
  const counts = reviewEntryCounts(entries);
  const prStatus = pull ? pullStatus(pull) : null;
  const pendingItems = buildPendingItems(drafts, allPendingSuggestions);
  // Author-side pending list: the accepted-suggestion infos are derived from
  // submitted suggestion comments × the author's `dismissed` map. They drive
  // the post-commit auto-resolve.
  const acceptedSuggestionInfos = useMemo<AcceptedSuggestionInfo[]>(
    () =>
      comments
        .filter((c) => c.meta?.kind === "suggestion" && dismissed[c.id] === "accepted")
        .map((c) => ({
          commentId: c.id,
          path: c.meta?.path ?? "",
          quote: c.meta?.quote ?? "",
          replacement: extractSuggestionBlock(c.body) ?? "",
          line: c.meta?.range?.sl ?? 1,
        })),
    [comments, dismissed],
  );
  const pendingAuthorItems = useMemo(
    () => buildAuthorPendingItems(drafts, suggestionEdits, acceptedSuggestionInfos),
    [drafts, suggestionEdits, acceptedSuggestionInfos],
  );
  // The FileEdits a commit should carry: one per path whose editor content
  // diverges from its base, each listing the Threads of the suggestions
  // accepted into it so a *successful* commit resolves them (issue #278).
  // Both the mirror effect below and submitAuthor build them here, or the
  // two could persist the same path with and without resolveOnCommit.
  const fileEditsFromEdits = useCallback((): Map<string, FileEdit> => {
    const wanted = new Map<string, FileEdit>();
    if (!headSha) return wanted;
    const threadsByPath = new Map<string, string[]>();
    const syncedThreadIds = new Set(
      (prRepository?.getLocalState().threads ?? [])
        .filter((t) => t.state === "synced")
        .map((t) => t.id),
    );
    for (const info of acceptedSuggestionInfos) {
      const threadId = commentViewByRemoteId.get(info.commentId)?.comment.threadId;
      if (threadId === undefined || !syncedThreadIds.has(threadId)) continue;
      threadsByPath.set(info.path, [...(threadsByPath.get(info.path) ?? []), threadId]);
    }
    for (const [path, edit] of Object.entries(suggestionEdits)) {
      if (!isMeaningfulEdit(edit.base, edit.source)) continue;
      const resolveOnCommit = threadsByPath.get(path);
      wanted.set(`fileedit-${path}`, {
        id: `fileedit-${path}`,
        state: "draft",
        path,
        // The edit's own baseSha (the head its base text was fetched at) is
        // what the commit conflict check compares (issue #187); edits
        // persisted before the field existed fall back to the current head.
        baseSha: edit.baseSha ?? headSha,
        editedSource: edit.source,
        ...(resolveOnCommit ? { resolveOnCommit } : {}),
      });
    }
    return wanted;
  }, [acceptedSuggestionInfos, commentViewByRemoteId, headSha, prRepository, suggestionEdits]);
  // The active pending-items list for the topbar count + Submit confirm modal —
  // author mode shows author-shaped items, reviewer keeps the existing flow.
  const activePendingItems = role === "author" ? pendingAuthorItems : pendingItems;
  const visibleEntries = filterReviewEntries(entries, reviewFilter);
  // Threads currently shown in the sidebar (per the active filter). The editor
  // highlights and clickable anchors track this set, so resolved threads are
  // highlighted exactly when the Resolved facet is selected.
  const visibleThreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of visibleEntries) if (e.kind === "thread") ids.add(e.thread.id);
    return ids;
  }, [visibleEntries]);

  // The createdAtSha source for a comment, if we've fetched it — feeds the
  // diff-based re-anchoring path (undefined → quote-search fallback).

  // Highlighted span of each thread on the current file, so clicking commented
  // text in the body can map back to its thread.
  const threadRanges = useMemo<ThreadRange[]>(() => {
    const docLen = source.length;
    const res: ThreadRange[] = [];
    for (const t of threads) {
      if (t.path !== curPath) continue;
      // Only threads visible in the sidebar (per the active filter) are clickable
      // in the document — resolved threads become clickable when Resolved is on.
      if (!visibleThreadIds.has(t.id)) continue;
      let from: number;
      let to: number;
      if (t.rootComment?.meta) {
        // L7e-1: read the reanchored position from the new layer's
        // CommentView instead of running legacy reanchorComment inline.
        const dp = commentViewByCid.get(t.rootComment.meta.cid)?.displayPosition;
        if (!dp || dp.status === "outdated") continue;
        from = lineColToOffset(dp.range.sl, dp.range.sc, lineStarts);
        to = lineColToOffset(dp.range.el, dp.range.ec, lineStarts);
      } else if (t.rootDraft) {
        from = lineColToOffset(t.rootDraft.range.sl, t.rootDraft.range.sc, lineStarts);
        to = lineColToOffset(t.rootDraft.range.el, t.rootDraft.range.ec, lineStarts);
      } else {
        continue;
      }
      if (from >= 0 && to <= docLen && from < to) res.push({ id: t.id, from, to });
    }
    return res;
  }, [threads, visibleThreadIds, source, lineStarts, curPath, commentViewByCid]);

  // The current-doc char span of each pending suggestion's edited text, so a
  // click on the suggested text in the editor maps back to its review item. The
  // ranges align by index with pendingSuggestions (same hunk order).
  const suggestionRanges = useMemo<{ cid: string; from: number; to: number }[]>(() => {
    if (role !== "reviewer" || source === baseSource) return [];
    return suggestionEditRanges(baseSource, source)
      .map((r, k) => ({ cid: pendingSuggestions[k]?.cid, from: r.from, to: r.to }))
      .filter((r): r is { cid: string; from: number; to: number } => Boolean(r.cid));
  }, [role, source, baseSource, pendingSuggestions]);

  // (PR info / help popover outside-click handlers live in useUiPanels.)

  // Starting a fresh selection (new-comment composer) means focus moved off the
  // emphasized item, so drop the emphasis. Programmatic jump/emphasis selections
  // set suppressNextAnchor and never set `anchor`, so they don't trigger this.
  useEffect(() => {
    if (anchor) clearEmphasis();
  }, [anchor]);

  // Restore + device-flow polling now live in useAuthFlow.
  // pull / files / head SHA + ref / viewer derive from the Repository's
  // AppState (see the bootstrap block above). Pick the first file once the
  // file list arrives, and derive role once we know both the viewer and the
  // PR author.
  useEffect(() => {
    if (files.length === 0) return;
    setSelectedPath((prev) => prev ?? files[0]?.path ?? null);
  }, [files]);
  useEffect(() => {
    if (viewerLogin && pull) setRole(deriveRole(viewerLogin, pull.author));
  }, [viewerLogin, pull]);

  // L6d-1: while we are author, mirror suggestionEdits into Repository's
  // LocalState as FileEdits so a future repository.submitDrafts() (L6d-3)
  // can emit one Commit step for all pending edits. Reviewer doesn't need
  // this — their edits become suggestion-block Comments at submit time
  // (L6c). Effect upserts every (path, source) pair that diverges from
  // base; drafts no longer represented get discarded.
  useEffect(() => {
    if (!prRepository || !headSha || role !== "author") return;
    void (async () => {
      const wanted = fileEditsFromEdits();
      // Only write what actually differs: every write notifies subscribers,
      // which rebuilds this effect's inputs, which would re-run it forever.
      const existing = new Map(prRepository.getLocalState().fileEdits.map((fe) => [fe.id, fe]));
      for (const fe of wanted.values()) {
        if (!sameFileEdit(existing.get(fe.id), fe)) await prRepository.upsertFileEdit(fe);
      }
      for (const fe of prRepository.getLocalState().fileEdits) {
        if (fe.state === "draft" && !wanted.has(fe.id)) {
          await prRepository.discardFileEdit(fe.id);
        }
      }
    })();
  }, [fileEditsFromEdits, prRepository, headSha, role]);

  // Per-file content load now lives in useSelectedFileContent.
  // Re-anchoring file content (per createdAtSha) is fetched by the new
  // layer's bootstrap/refresh via fileContentTargets — App.tsx no longer
  // maintains its own oldSources cache.

  // Drafts restore + persistence now live in useDrafts.
  // Suggestion-edits restore + persistence now live in useSuggestionEdits.

  // Author's accept/reject decisions (R3) restore + persistence now live
  // in useDismissedSuggestions.

  // Push the base text into CM for tracked changes (reviewer suggest).
  useEffect(() => {
    cmRef.current?.view?.dispatch({ effects: setBaseText.of(baseSource) });
  }, [baseSource]);

  // Highlight comment/draft anchors over the CM body (R6); pending uses a distinct color.
  // Always clip ranges to the current CM document length (out-of-range ranges crash on map).
  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    const docLen = view.state.doc.length;
    const clip = (r: { from: number; to: number; pending?: boolean }) =>
      r.from >= 0 && r.to <= docLen && r.from < r.to;
    // The document highlights track what the sidebar shows: only comments whose
    // thread is currently visible (per the filter) are highlighted, so resolved
    // threads light up exactly when the Resolved facet is selected. Resolution-
    // event markers carry the root's anchor but aren't real messages → excluded.
    // L7e-1: each visible comment's editor position comes from the
    // CommentView's displayPosition (new layer's reanchor result).
    const existing = comments
      .filter(
        (c) =>
          c.meta &&
          c.meta.path === curPath &&
          c.meta.kind !== "suggestion" &&
          !c.meta.event &&
          visibleThreadIds.has(c.meta.thread),
      )
      .flatMap((c) => {
        const dp = commentViewByCid.get((c.meta as CommentMetadata).cid)?.displayPosition;
        if (!dp || dp.status === "outdated") return [];
        return [
          {
            from: lineColToOffset(dp.range.sl, dp.range.sc, lineStarts),
            to: lineColToOffset(dp.range.el, dp.range.ec, lineStarts),
          },
        ];
      })
      .filter(clip);
    const pending = drafts
      .filter((d) => d.path === curPath && visibleThreadIds.has(d.thread))
      .map((d) => ({
        from: lineColToOffset(d.range.sl, d.range.sc, lineStarts),
        to: lineColToOffset(d.range.el, d.range.ec, lineStarts),
        pending: true,
      }))
      .filter(clip);
    view.dispatch({ effects: setCommentHighlights.of([...existing, ...pending]) });
  }, [comments, drafts, visibleThreadIds, source, lineStarts, selectedPath, commentViewByCid]);

  // Render submitted suggestions in the body as tracked changes (old = strikethrough / new = green block).
  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    const marks = buildSuggestionMarks({
      comments,
      source,
      lineStarts,
      currentPath: curPath,
      dismissed,
      displayPositionFor: (cid) => commentViewByCid.get(cid)?.displayPosition ?? null,
      resolvedKeys: resolvedThreadKeys,
    });
    view.dispatch({ effects: setSuggestionMarks.of(marks) });
  }, [comments, source, lineStarts, selectedPath, dismissed, commentViewByCid, resolvedThreadKeys]);

  // Scroll the emphasized item (e.g. after clicking its highlighted text in the
  // body) into view in the sidebar. The id is a thread id or a live-suggestion
  // cid, so match either item attribute.
  useEffect(() => {
    if (!emphasizedThreadId) return;
    const esc = CSS.escape(emphasizedThreadId);
    document
      .querySelector(`[data-thread-id="${esc}"], [data-suggestion-cid="${esc}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [emphasizedThreadId, reviewFilter]);

  // When a new suggestion is created (a pending-suggestion id that wasn't there
  // before), scroll its item into view in the review list so the reviewer sees
  // the suggestion they just made.
  useEffect(() => {
    const ids = pendingSuggestions.map((s) => s.cid);
    const fresh = ids.filter((cid) => !seenSuggestionCids.current.has(cid));
    seenSuggestionCids.current = new Set(ids);
    const newest = fresh.at(-1);
    if (!newest) return;
    document
      .querySelector(`[data-suggestion-cid="${CSS.escape(newest)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [pendingSuggestions]);

  const jumpTo = (c: ExistingComment) => {
    const view = cmRef.current?.view;
    if (!view || !c.meta) return;
    if (c.meta.path !== (selectedPath ?? "sample")) {
      setSelectedPath(c.meta.path);
      return;
    }
    const dp = commentViewByCid.get(c.meta.cid)?.displayPosition;
    if (!dp || dp.status === "outdated") return;
    const from = lineColToOffset(dp.range.sl, dp.range.sc, lineStarts);
    const to = lineColToOffset(dp.range.el, dp.range.ec, lineStarts);
    suppressNextAnchor.current = true;
    view.dispatch({
      selection: { anchor: from, head: to },
      scrollIntoView: true,
    });
    suppressNextAnchor.current = false; // update listener already ran synchronously
    view.focus();
  };

  const meta: CommentMetadata | null = anchor
    ? {
        cid: "preview",
        path: selectedPath ?? "sample",
        range: { sl: anchor.startLine, sc: anchor.startCol, el: anchor.endLine, ec: anchor.endCol },
        quote: anchor.quotedText,
        sha: headSha ?? "",
        thread: "preview",
        kind: "comment",
      }
    : null;
  const previewBody = meta ? embedMetadata(commentBody || "(comment body)", meta) : "";
  const restored = previewBody ? extractMetadata(previewBody) : null;

  // Collapse the editor selection (deselect) without removing the comment
  // highlight, which is driven separately by the draft ranges.
  const collapseSelection = () => {
    const view = cmRef.current?.view;
    if (!view) return;
    view.dispatch({ selection: { anchor: view.state.selection.main.head } });
  };

  const addDraft = async () => {
    if (!anchor || !ref || !prRepository) return;
    const inDiff = isRangeInDiff(diffRanges, anchor.startLine, anchor.endLine);
    const path = selectedPath ?? "sample";
    const id = crypto.randomUUID();
    const draft: PendingDraft = {
      cid: id,
      path,
      inDiff,
      range: { sl: anchor.startLine, sc: anchor.startCol, el: anchor.endLine, ec: anchor.endCol },
      quote: anchor.quotedText,
      sha: headSha ?? "",
      thread: id,
      body: commentBody.trim() || "(no comment)",
      kind: "comment",
      permalink:
        !inDiff && headSha
          ? buildBlobPermalink(ref, path, headSha, anchor.startLine, anchor.endLine)
          : undefined,
    };
    await prRepository.upsertComment(pendingDraftToComment(draft, viewerLogin ?? "you"));
    setCommentBody("");
    collapseSelection(); // deselect; the pending highlight stays
    setAnchor(null);
  };

  const discardComposer = () => {
    setCommentBody("");
    collapseSelection();
    setAnchor(null);
  };

  // Clicking the selection bubble opens the composer on the pending selection
  // and dismisses the bubble. The composer then drives the rest of the flow via
  // `anchor`, unchanged. The editor selection is left intact (quote captured).
  const openComposer = () => {
    if (!selection) return;
    setAnchor(selection);
    setSelection(null);
    setBubblePos(null);
  };

  // Position the bubble below-right of the current selection's end (or hide it
  // when there is no selection). Recomputed from the live editor state so it
  // stays correct on scroll/resize and after the mouse settles.
  const refreshBubble = useCallback(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    const anchor = cmSelectionToAnchor(view.state);
    if (!anchor) {
      setBubblePos(null);
      return;
    }
    const coords = view.coordsAtPos(anchor.endOffset);
    setBubblePos(coords ? bubbleAnchorPoint(coords) : null);
  }, []);

  // The bubble should appear once the user *finishes* selecting (mouse release),
  // not jump around mid-drag. Track the pressed state: while the button is held
  // we suppress the bubble; on release we show it.
  const selectingRef = useRef(false);
  const onEditorMouseDown = () => {
    selectingRef.current = true;
    setBubblePos(null);
  };
  const onEditorMouseUp = () => {
    selectingRef.current = false;
    // Let CodeMirror settle the selection, then show the bubble.
    requestAnimationFrame(refreshBubble);
  };

  // Keyboard selection (shift+arrows) has no mouse release, so show the bubble
  // when the selection changes while no drag is in progress. A collapsed
  // selection clears it.
  useEffect(() => {
    if (selectingRef.current) return;
    if (!selection) {
      setBubblePos(null);
      return;
    }
    refreshBubble();
  }, [selection, refreshBubble]);

  // Keep the bubble pinned to the selection as the editor scrolls or the window
  // resizes; it hides itself if the selection end scrolls out of view.
  useEffect(() => {
    if (!selection) return;
    const scroller = cmRef.current?.view?.scrollDOM;
    if (!scroller) return;
    scroller.addEventListener("scroll", refreshBubble, { passive: true });
    window.addEventListener("resize", refreshBubble);
    return () => {
      scroller.removeEventListener("scroll", refreshBubble);
      window.removeEventListener("resize", refreshBubble);
    };
  }, [selection, refreshBubble]);

  // Thread reply: inherit the thread's anchor (see replyAnchor) and add a
  // draft with the same thread id — which equals the data layer's Thread id
  // (issue #183).
  const addReply = async (thread: ReviewThread) => {
    if (!ref || !replyText.trim()) return;
    const a = replyAnchor(thread, headSha);
    if (!a) return;
    const ranges = parseRightRanges(files.find((f) => f.path === a.path)?.patch);
    const inDiff = isRangeInDiff(ranges, a.range.sl, a.range.el);
    const draft: PendingDraft = {
      cid: crypto.randomUUID(),
      path: a.path,
      inDiff,
      range: a.range,
      quote: a.quote,
      sha: a.sha,
      thread: a.thread,
      body: replyText.trim(),
      kind: "comment",
      permalink:
        !inDiff && headSha
          ? buildBlobPermalink(ref, a.path, headSha, a.range.sl, a.range.el)
          : undefined,
    };
    if (!prRepository) return;
    // parentLocalId resolves the reply's target inside Repository.LocalState:
    //  - reply to a submitted thread → root Comment's LocalId via remoteId
    //  - reply to a still-draft thread → the root draft's cid (== its
    //    LocalState Comment.id)
    const parentLocalId = thread.rootComment
      ? commentViewByRemoteId.get(thread.rootComment.id)?.comment.id
      : (thread.rootDraft?.cid ?? undefined);
    if (!parentLocalId) return;
    await prRepository.upsertComment(
      pendingDraftToComment(draft, viewerLogin ?? "you", parentLocalId),
    );
    cancelReply();
  };

  const toggleFacet = (f: ReviewFacet) =>
    setReviewFilter((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  // Bark-authored and foreign threads take the same path: the sidebar's t.id
  // equals the Repository Thread id (see resolvableThreadKeys above), and the
  // Resolve affordance is gated on that Thread having a remote identity — so
  // setThreadResolved always finds its target entity, whether the thread was
  // created by Bark or natively on GitHub. The Reconciler flips
  // Thread.resolved and the Executor runs the GraphQL resolve/unresolve
  // mutation (review threads) or rewrites the root issue comment's metadata
  // (out-of-diff threads, issue #270) in its sync cycle; commentViews picks
  // up the change via the listener — no extra refresh needed.
  const setThreadResolved = async (t: ReviewThread, resolved: boolean) => {
    if (!t.rootComment) return;
    setResolvingId(t.id);
    setError(null);
    try {
      if (!prRepository) {
        reportError("Data layer is not ready yet. Try again in a moment.");
        return;
      }
      await prRepository.setThreadResolved(t.id, resolved);
    } catch (e) {
      reportError(errMessage(e));
    } finally {
      setResolvingId(null);
    }
  };

  // author: record an accept/reject decision on a submitted suggestion.
  // (setDecision now lives in useDismissedSuggestions.)

  // author: accept a suggestion. Stage two things:
  //   - apply the replacement to the editor source so the author sees the change
  //   - record "accepted" in the dismissed map (queue for thread resolve on Submit)
  // Both survive reload via the per-file edit store, so accepts compose with
  // manual edits and other accepts in a single batched commit on Submit.
  const acceptSuggestion = async (c: ExistingComment) => {
    const meta = c.meta;
    if (!meta) return;
    const view = commentViewByCid.get(meta.cid);
    if (!view) return; // not yet in commentViews (bootstrap in flight)
    // The revision the suggestion's quote was taken from. It is what the
    // line-local merge re-locates the target line from when the exact quote is
    // no longer in the document (issue #269).
    const anchorSource =
      prRepository
        ?.getRemoteState()
        .fileContents.find((f) => f.sha === meta.sha && f.path === meta.path)?.source ??
      (meta.sha === headSha ? baseSource : null);
    const newSource = applyAcceptedSuggestion({
      source,
      baseSource,
      lineStarts,
      meta,
      replacement: extractSuggestionBlock(c.body) ?? "",
      displayPosition: view.displayPosition,
      anchorSource,
    });
    if (newSource === null) {
      // The target text moved or changed since the suggestion was written
      // (quote no longer matches at the reanchored position) — applying
      // would corrupt the document (issue #176).
      reportError(
        "Can't apply this suggestion: the document changed and its target text no longer matches.",
      );
      return;
    }
    setSource(newSource);
    persistSuggestionEdit(curPath, newSource, baseSource, suggestionComments, headSha ?? undefined);
    await setDecision(c.id, "accepted");
  };

  const rejectSuggestion = async (c: ExistingComment) => {
    await setDecision(c.id, "rejected");
  };

  const removeDraft = async (cidToRemove: string) => {
    if (!prRepository) return;
    await prRepository.discardComment(cidToRemove);
  };

  // Materialize the reviewer's live suggestion edits into real drafts at submit
  // time (they are kept "live" in the editor until then; task 4).
  const suggestionsToDrafts = (): PendingDraft[] =>
    allPendingSuggestions.map((s) => {
      const id = crypto.randomUUID();
      return {
        cid: id,
        path: s.path,
        inDiff: s.inDiff,
        range: s.range,
        quote: s.quote,
        // The hunk's lines are in the coordinates of the head the edit's base
        // was fetched at, which for a file not currently open may be older
        // than headSha (only the open file is rebased on load). The Planner
        // maps the anchor to the current head at submit (issue #265).
        sha: s.baseSha ?? headSha ?? "",
        thread: id,
        body: s.body,
        kind: "suggestion",
        suggestion: s.replacement,
        permalink:
          !s.inDiff && headSha
            ? buildBlobPermalink(ref!, s.path, headSha, s.range.sl, s.range.el)
            : undefined,
      };
    });

  // Compose the visible body for a submitted draft:
  //   in-diff:     <body> + (suggestion block if any)
  //   out-of-diff: <body> + (suggestion block if any) + note + quoted + permalink
  // The new layer's Comment.body is the *visible* body — the Executor appends
  // the metadata fence at post time, so the wire format matches the legacy
  // path exactly.
  const composeDraftBody = (d: PendingDraft): string => {
    const suggestion =
      d.kind === "suggestion" ? `\n\n${buildSuggestionBlock(d.suggestion ?? "")}` : "";
    if (d.inDiff) return `${d.body}${suggestion}`;
    const quoted = d.quote
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const note =
      d.kind === "suggestion"
        ? "\n\n(Out of diff: this suggestion will not show an Apply button.)"
        : "";
    return `${d.body}${suggestion}${note}\n\n${quoted}\n${d.permalink ?? ""}`.trimEnd();
  };

  // Submit steps never throw: a failed post parks the Comment (and the Thread
  // it would have created) back as draft + lastError, and a failed resolve
  // parks the Thread. Announce the first one — with a count when several
  // comments failed — and hand back the failed comment ids so the caller can
  // keep the local work they were built from (issues #266, #268).
  const reportSubmitErrors = (): Set<string> => {
    const local = prRepository?.getLocalState();
    if (!local) return new Set();
    const failed = local.comments.filter((c) => c.lastError);
    const first = failed[0]?.lastError ?? local.threads.find((t) => t.lastError)?.lastError;
    if (first) {
      reportError(
        failed.length > 1
          ? `${first.message} (${failed.length} comments failed to post)`
          : first.message,
      );
    }
    return new Set(failed.map((c) => c.id));
  };

  const submitReview = async () => {
    if (!client || !ref) return;
    if (!prRepository) {
      reportError("Data layer is not ready yet. Try again in a moment.");
      return;
    }
    const suggestionDrafts = suggestionsToDrafts();
    const toSubmit = [...drafts, ...suggestionDrafts];
    if (toSubmit.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      // In-diff and out-of-diff drafts both go through Repository.submitDrafts.
      // The Planner routes Comments based on the bootstrap's isInDiff predicate:
      // in-diff → PostReviewBatch, out-of-diff → PostIssueComment. The Bark-
      // specific quoted-body / permalink composition for out-of-diff lives on
      // Comment.body (ADR 0001 §3: body is the visible body only), so the new
      // layer's wire format (visible body + metadata fence) carries it as-is.
      const inRepo = new Set(prRepository.getLocalState().comments.map((c) => c.id));
      for (const d of toSubmit) {
        if (inRepo.has(d.cid)) continue; // already double-written by L4/L6a
        const body = composeDraftBody(d);
        // parentLocalId: top-level (d.cid === d.thread) → undefined;
        // reply to a submitted thread → root comment's LocalId via
        // commentViewByRemoteId; reply to a still-draft thread →
        // rootDraft.cid (same as draft.thread).
        const thread = threads.find((t) => t.id === d.thread);
        const parentLocalId =
          d.cid === d.thread
            ? undefined
            : thread?.rootComment
              ? commentViewByRemoteId.get(thread.rootComment.id)?.comment.id
              : (thread?.rootDraft?.cid ?? undefined);
        await prRepository.upsertComment(
          pendingDraftToComment({ ...d, body }, viewerLogin ?? "you", parentLocalId),
        );
      }
      // The Planner maps each draft's anchor into the current head, which
      // needs the source at both shas in RemoteState.fileContents. Drafts
      // just upserted (suggestions at an older baseSha in particular) were
      // not yet targets of the last refresh, so refresh first.
      await safeRefresh?.();
      await prRepository.submitDrafts();
      // No explicit draft clear is needed — submitDrafts flips each draft
      // Comment from "draft" → "syncing" → "synced", so they fall out of
      // the drafts useMemo automatically. A failed or unconfirmed post
      // parks the comment back as draft + lastError; step outcomes don't
      // throw, so surface that here (issue #266).
      const failedCids = reportSubmitErrors();
      // The reviewer's editor edits leave the browser only as these comments,
      // so dropping them after a comment that never reached GitHub would lose
      // work nothing else holds (issue #268). Keep them for the retry.
      if (!suggestionDrafts.some((d) => failedCids.has(d.cid))) {
        setSource(baseSource); // live suggestion edits are now submitted
        setSuggestionComments({});
        // All files' suggestions just went out, so drop every persisted edit
        // (not only the open file's) and cancel any debounced write that would
        // revive them.
        await discardAllPersistedEdits();
      }
      // Repository.submitDrafts already updated LocalState with the synced
      // comments (via Reconciler / apply), so commentViews reflects the
      // just-submitted items without an extra fetch.
      // The pending items just became submitted; if the list was filtered to
      // "Pending" it would now look empty, so make sure "submitted" is on —
      // without forcing the user's "resolved" preference on.
      setReviewFilter(revealSubmittedFacets);
      setEmphasizedThreadId(null);
    } catch (e) {
      reportError(errMessage(e));
    } finally {
      setLoading(false);
      setShowSubmitConfirm(false);
    }
  };

  // Author Submit: flush every staged action together — drafts (in-diff and
  // out-of-diff), file edits, and accepted-suggestion thread resolves —
  // through Repository.submitDrafts.
  const submitAuthor = async () => {
    if (!client || !ref || !headRef || !headSha) return;
    if (!prRepository) {
      reportError("Data layer is not ready yet. Try again in a moment.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Drafts + FileEdits + accepted-thread resolves all go through
      // Repository.submitDrafts(). Planner routes Comments to PostReviewBatch
      // (in-diff) or PostIssueComment (out-of-diff); body composition lives
      // on Comment.body via composeDraftBody.

      // 1. Drafts → Repository.
      const inRepo = new Set(prRepository.getLocalState().comments.map((c) => c.id));
      for (const d of drafts) {
        if (inRepo.has(d.cid)) continue;
        const body = composeDraftBody(d);
        const thread = threads.find((t) => t.id === d.thread);
        const parentLocalId =
          d.cid === d.thread
            ? undefined
            : thread?.rootComment
              ? commentViewByRemoteId.get(thread.rootComment.id)?.comment.id
              : (thread?.rootDraft?.cid ?? undefined);
        await prRepository.upsertComment(
          pendingDraftToComment({ ...d, body }, viewerLogin ?? "you", parentLocalId),
        );
      }

      // 2. Re-sync FileEdits authoritatively (the L6d-1 effect is best-
      //    effort; this is the source of truth for the impending commit).
      //    Each carries the accepted suggestions' threads in resolveOnCommit.
      const wantedFileEdits = fileEditsFromEdits();
      for (const fe of wantedFileEdits.values()) {
        await prRepository.upsertFileEdit(fe);
      }
      for (const fe of prRepository.getLocalState().fileEdits) {
        if (fe.state === "draft" && !wantedFileEdits.has(fe.id)) {
          await prRepository.discardFileEdit(fe.id);
        }
      }

      // 3. Accepted suggestions whose replacement is already in the file
      //    produce no FileEdit, so there is no commit to wait for: resolve
      //    them now. The rest ride on their FileEdit's resolveOnCommit and
      //    are resolved by the Commit's own success (issue #278).
      const acceptedResolvedRemoteIds: number[] = [];
      for (const info of acceptedSuggestionInfos) {
        const view = commentViewByRemoteId.get(info.commentId);
        if (!view) continue;
        if (!wantedFileEdits.has(`fileedit-${info.path}`)) {
          await prRepository.setThreadResolved(view.comment.threadId, true);
        }
        acceptedResolvedRemoteIds.push(info.commentId);
      }

      // 4. Submit — Reconciler emits PostReviewBatch / PostIssueComment /
      //    PostReply + one Commit step for the FileEdits, then a follow-up
      //    cycle for the threads that Commit flipped to syncing.
      await prRepository.submitDrafts();
      reportSubmitErrors();
      const newHeadSha = prRepository.getRemoteState().pullRequest?.headSha ?? headSha;

      // A failed Commit (e.g. the #187 conflict check, or a network error)
      // parks its FileEdits as draft+lastError; step outcomes don't throw.
      // Keep the author's editor edits and accepted-decision queue in that
      // case — discarding them here would lose the work while GitHub has
      // nothing committed. The parked FileEdits retry on the next submit.
      const commitFailure = prRepository
        .getLocalState()
        .fileEdits.find((fe) => fe.lastError)?.lastError;

      // 5. Legacy state cleanup. Drafts auto-fall-out of the drafts useMemo
      //    once submitDrafts flips them past "draft"; only suggestionEdits +
      //    accepted-decision state still own their own storage.
      if (commitFailure) {
        reportError(
          `Commit failed: ${commitFailure.message} Your pending edits are kept — ` +
            `review the reloaded file and submit again.`,
        );
        // Recovery: headSha derives from RemoteState.pullRequest, so if the
        // conflict check advanced the remote head, the open file already
        // reloads at it and the load-time rebase (rebaseLoadedEdit) merges
        // the upstream changes into the author's edits; other conflicted
        // files re-base when opened. Nothing to poke here.
      } else {
        await discardAllPersistedEdits();
        if (acceptedResolvedRemoteIds.length > 0) {
          await clearAcceptedDecisions(ref, acceptedResolvedRemoteIds);
          setDismissed((prev) => {
            const drop = new Set(acceptedResolvedRemoteIds.map((id) => String(id)));
            const next: Record<string, SuggestionDecision> = {};
            for (const [k, v] of Object.entries(prev)) {
              if (v === "accepted" && drop.has(k)) continue;
              next[k] = v;
            }
            return next;
          });
        }
      }

      // 6. New head SHA → reload the open file. (headSha itself advanced
      //    already: the commit's apply step wrote it into RemoteState.)
      if (newHeadSha !== headSha) {
        if (selectedPath) {
          const newText = (await fetchFileContent(client, ref, newHeadSha, selectedPath)).source;
          setSource(newText);
          setBaseSource(newText);
          setSuggestionComments({});
        }
      }

      // 7. Repository.submitDrafts already updated LocalState with the synced
      //    comments + threads (via Reconciler / apply), so commentViews
      //    reflects them without an extra fetch.
      setReviewFilter(revealSubmittedFacets);
      setEmphasizedThreadId(null);
    } catch (e) {
      reportError(errMessage(e));
    } finally {
      setLoading(false);
      setShowSubmitConfirm(false);
    }
  };

  // After the auth hook drops the token, also wipe any PR-load-derived state
  // so the surface returns to its "no PR loaded" baseline (matches what the
  // legacy in-line implementation did).
  const handleClearToken = async () => {
    await clearAuthToken();
    setError(null);
    setNeedsInstall(false);
    // Drop the token-bound Repository built with the now-revoked token —
    // pull / files / viewer all derive from it, so this alone returns the
    // PR-derived surface to its baseline. The bootstrap effect early-returns
    // once the token is null, so it never clears it itself. Without this,
    // the previous session's Repository (and its stale transport) survives
    // sign-out and keeps rendering until the next bootstrap resolves (#192).
    // Storage is not cleared (consistent with logging back in as the same
    // user). Suggestion edits + dismissed still own their own legacy state.
    setPrRepository(null);
    setRefreshPr(null);
    resetSuggestionEdits();
    resetDismissed();
    setSelectedPath(null);
    setSource(ref ? "" : sampleDoc);
    setBaseSource(ref ? "" : sampleDoc);
    setAnchor(null);
    setSelection(null);
    setBubblePos(null);
  };

  // flushSuggestionEdits / persistSuggestionEdit now live in useSuggestionEdits.

  const onSourceChange = (v: string) => {
    // Guard against edits fired before the selected file has loaded — at
    // that point `source`/`baseSource` still belong to the previous file,
    // so persisting under `curPath` would corrupt it (issue #185). The
    // editor is also held read-only via cmExtensions; this is belt-and-braces.
    if (!fileReady) return;
    setSource(v);
    // baseSource was fetched at the current headSha (the load effect keys on
    // it), so stamping it as the edit's baseSha is faithful (issue #187).
    persistSuggestionEdit(curPath, v, baseSource, suggestionComments, headSha ?? undefined);
  };

  const discardEdits = () => {
    setSource(baseSource);
    setSuggestionComments({});
    persistSuggestionEdit(curPath, baseSource, baseSource, {});
  };

  // Drop every pending item — comment/reply drafts, all files' in-progress
  // edits (the reviewer's live suggestions AND the author's edits/accepts), and
  // (author only) the pending accepted-suggestion decisions. The open editor
  // is reset to its base so no stale change lingers, and any debounced edit
  // write is cancelled so it can't resurrect what we just cleared. Rejected
  // suggestion decisions stay — they keep the suggestion hidden, not pending.
  const discardAllPending = async () => {
    setShowDiscardConfirm(false);
    setSource(baseSource);
    setSuggestionComments({});
    resetSuggestionEdits();
    // Clear the persisted suggestion-edits key for this PR (drafts are
    // owned by Repository now and discarded individually below).
    if (ref) await saveSuggestionEdits(ref, {});
    if (prRepository) {
      const localCids = drafts.map((d) => d.cid);
      for (const cid of localCids) await prRepository.discardComment(cid);
    }
    if (role === "author") {
      // Clear the "accepted" decisions so the topbar count drops to 0 and the
      // next Submit wouldn't try to resolve threads the author no longer wants.
      const acceptedIds = Object.entries(dismissed)
        .filter(([, v]) => v === "accepted")
        .map(([k]) => Number(k));
      if (acceptedIds.length > 0) {
        setDismissed((prev) => {
          const next: Record<string, SuggestionDecision> = {};
          for (const [k, v] of Object.entries(prev)) if (v !== "accepted") next[k] = v;
          return next;
        });
        if (ref) await clearAcceptedDecisions(ref, acceptedIds);
      }
    }
  };

  const setSuggestionComment = (cid: string, value: string) => {
    const next = { ...suggestionComments, [cid]: value };
    setSuggestionComments(next);
    persistSuggestionEdit(curPath, source, baseSource, next, headSha ?? undefined);
  };

  // Side item click → scroll to the target in the body and highlight the selection.
  const jumpToOffsets = (from: number, to: number) => {
    const view = cmRef.current?.view;
    if (!view) return;
    const len = view.state.doc.length;
    if (from < 0 || to > len || from >= to) return;
    suppressNextAnchor.current = true;
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    suppressNextAnchor.current = false; // update listener already ran synchronously
    view.focus();
  };

  const jumpToDraft = (d: PendingDraft) => {
    if (d.path !== (selectedPath ?? "sample")) {
      setSelectedPath(d.path);
      return;
    }
    jumpToOffsets(
      lineColToOffset(d.range.sl, d.range.sc, lineStarts),
      lineColToOffset(d.range.el, d.range.ec, lineStarts),
    );
  };

  // Scroll the sidebar so the given item's card sits at the same viewport height
  // as the current editor selection — keeps the text and its review item visible
  // together even when the list is long. Runs after layout settles. `id` is a
  // thread id or a live-suggestion cid.
  const alignItemToText = (id: string) => {
    requestAnimationFrame(() => {
      const view = cmRef.current?.view;
      const sidebar = sidebarRef.current;
      if (!view || !sidebar) return;
      const coords = view.coordsAtPos(view.state.selection.main.from);
      if (!coords) return;
      const esc = CSS.escape(id);
      const item = sidebar.querySelector<HTMLElement>(
        `[data-thread-id="${esc}"], [data-suggestion-cid="${esc}"]`,
      );
      if (!item) return;
      const delta = item.getBoundingClientRect().top - coords.top;
      if (Math.abs(delta) > 1) sidebar.scrollBy({ top: delta, behavior: "smooth" });
    });
  };

  // Click commented (highlighted) text in the body → emphasize its thread in the
  // sidebar and open its reply box (so it behaves like clicking the thread
  // itself). The editor cursor is left where the user clicked — we must not
  // hijack the selection, or editing/suggesting at that spot becomes impossible.
  const emphasizeThread = (hit: ThreadRange) => {
    if (!visibleEntries.some((e) => e.kind === "thread" && e.thread.id === hit.id)) {
      setReviewFilter(new Set<ReviewFacet>(["pending", "submitted", "resolved"])); // make sure the emphasized thread is visible
    }
    setEmphasizedThreadId(hit.id);
    // Only open the composer when a reply can actually anchor there (#183).
    const t = threads.find((x) => x.id === hit.id);
    if (t && canReplyToThread(t)) {
      if (replyTo !== hit.id) startReply(hit.id);
    }
    alignItemToText(hit.id);
  };

  // Emphasize a pending suggestion's review item (and reveal its comment field).
  // Unlike a thread it has no reply box, so clear replyTo. `select` selects the
  // suggested text in the editor too (when the item, not the text, was clicked).
  const emphasizeSuggestion = (cid: string, select: boolean) => {
    if (select) {
      const r = suggestionRanges.find((x) => x.cid === cid);
      if (r && r.from < r.to) jumpToOffsets(r.from, r.to);
    }
    if (!visibleEntries.some((e) => e.kind === "liveSuggestion" && e.suggestion.cid === cid)) {
      setReviewFilter(new Set<ReviewFacet>(["pending", "submitted", "resolved"])); // make sure the emphasized suggestion is visible
    }
    setEmphasizedThreadId(cid);
    cancelReply();
    alignItemToText(cid);
  };

  const onEditorClick = (e: ReactMouseEvent) => {
    const view = cmRef.current?.view;
    if (!view) return;
    // Only a plain click (not a drag-selection) navigates to the comment, so
    // selecting text that overlaps a comment is not hijacked.
    if (!view.state.selection.main.empty) return;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return;
    const hit = threadRangeAt(threadRanges, pos);
    if (hit) {
      emphasizeThread(hit);
      return;
    }
    const sHit = suggestionRanges.find((r) => r.from <= pos && pos <= r.to);
    if (sHit) emphasizeSuggestion(sHit.cid, false); // text already clicked; just emphasize the item
    else setEmphasizedThreadId(null); // clicked away from any comment → drop emphasis
  };

  if (prNum && !prNumberValid) {
    return <p className="notice notice--error">Invalid PR number in the review URL.</p>;
  }

  if (!tokenLoaded) return <p className="notice notice--muted">Loading…</p>;

  if (ref && !token) {
    return (
      <LoginGate
        owner={owner!}
        repo={repo!}
        prNum={prNum!}
        deviceAuth={deviceAuth}
        authStarting={authStarting}
        authError={authError}
        onStartDeviceFlow={startDeviceFlow}
        onAuthenticated={completeAuth}
      />
    );
  }

  // Authorized, but the initial load failed with 404/403 — almost always the
  // App isn't installed on this repo. Show a dedicated gate instead of dropping
  // the user into the review UI with a confusing "Not Found" notice.
  if (ref && needsInstall) {
    return (
      <InstallGate
        owner={owner}
        repo={repo}
        prNum={prNum}
        authMethod={authMethod}
        loading={loading}
        installUrl={installUrl}
        onRetry={retryLoad}
        onClearToken={handleClearToken}
      />
    );
  }

  const statusFor = (c: ExistingComment): AnchorStatus | null => {
    if (!c.meta || c.meta.path !== (selectedPath ?? "sample")) return null;
    // Read the displayPosition from the new layer. Bark comments are
    // keyed by cid (covers drafts + synced); foreign comments only by
    // remoteId.
    const view = commentViewByCid.get(c.meta.cid) ?? commentViewByRemoteId.get(c.id);
    return view ? displayPositionToAnchorStatus(view.displayPosition) : null;
  };

  // ---- unified review-list item renderers ----
  // Items never show a review/issue or suggestion tag, nor the filename; a
  // comment item is a body, a suggestion item is an old→new diff.
  const jumpToThread = (t: ReviewThread) => {
    if (t.rootComment?.meta) jumpTo(t.rootComment);
    else if (t.rootDraft) jumpToDraft(t.rootDraft);
  };

  // Click a thread → highlight it in the body and open its reply box, so adding
  // a comment goes into the existing thread instead of starting a new one.
  // Threads a reply can't anchor to (foreign issue comments, foreign review
  // comments without a line) get no composer — it would silently discard the
  // text (issue #183).
  const openThread = (t: ReviewThread) => {
    jumpToThread(t);
    setEmphasizedThreadId(t.id);
    if (canReplyToThread(t)) {
      if (replyTo !== t.id) startReply(t.id);
    } else {
      cancelReply();
    }
    alignItemToText(t.id);
  };

  // Click a pending suggestion → emphasize it (and select its text in the body).
  // Its comment field + actions only show while it is emphasized, so the list
  // stays compact when many suggestions are pending.
  const renderLiveSuggestion = (s: PendingSuggestion) => {
    const emphasized = emphasizedThreadId === s.cid;
    return (
      <div
        key={s.cid}
        data-suggestion-cid={s.cid}
        className={`thread thread--clickable${emphasized ? " thread--emphasized" : ""}`}
        onClick={() => emphasizeSuggestion(s.cid, true)}
      >
        <div className="comment__meta">
          <span className="badge badge--pending">pending</span>
        </div>
        <SuggestionDiff before={s.quote} after={s.replacement} />
        {emphasized ? (
          <div onClick={(e) => e.stopPropagation()}>
            <textarea
              className="field"
              value={suggestionComments[s.cid] ?? ""}
              onChange={(e) => setSuggestionComment(s.cid, e.target.value)}
              rows={2}
              placeholder="Add a comment (optional)"
            />
            <div className="comment__actions">
              <button type="button" className="btn btn--sm" onClick={discardEdits}>
                Discard edits
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const renderThread = (t: ReviewThread) => {
    const root = t.rootComment;
    const showAuthorActions = root?.meta?.kind === "suggestion" && role === "author";
    // Accept is gated on the reanchored position still matching the quoted
    // text — a shifted/outdated target would be corrupted by the apply
    // (issue #176).
    const canAccept =
      showAuthorActions && root?.meta
        ? canAcceptSuggestion(commentViewByCid.get(root.meta.cid)?.displayPosition)
        : false;
    // Resolvable only when the thread exists on GitHub with a remote identity
    // (resolvableThreadKeys): a review thread driven via GraphQL, or a Bark
    // out-of-diff thread whose root issue comment carries the resolved flag
    // (#270). A thread with neither would make Resolve a silent no-op (#182).
    // Reopen is withheld when resolution came from accepting a suggestion
    // (which resolves implicitly), not from an explicit resolve.
    const acceptedRoot = root?.meta?.kind === "suggestion" && dismissed[root.id] === "accepted";
    const canResolve = resolvableThreadKeys.has(t.id) && t.hasSubmitted && !acceptedRoot;
    return (
      <ThreadItem
        key={t.id}
        thread={t}
        rootStatus={root ? statusFor(root) : null}
        role={role}
        canResolve={canResolve}
        canAccept={canAccept}
        decision={root ? dismissed[root.id] : undefined}
        isResolving={resolvingId === t.id}
        emphasized={emphasizedThreadId === t.id}
        replyOpen={replyTo === t.id}
        replyText={replyText}
        onOpen={() => openThread(t)}
        onToggleResolve={() => void setThreadResolved(t, !t.resolved)}
        onAccept={() => root && void acceptSuggestion(root)}
        onReject={() => root && void rejectSuggestion(root)}
        onAddReply={() => addReply(t)}
        onCancelReply={cancelReply}
        onReplyTextChange={setReplyText}
        onRemoveDraft={removeDraft}
      />
    );
  };

  return (
    <div className="app">
      <Topbar
        prRef={ref}
        owner={owner}
        repo={repo}
        prNum={prNum}
        pull={pull}
        prStatus={prStatus}
        headSha={headSha}
        files={files}
        selectedPath={selectedPath}
        viewMode={viewMode}
        loading={loading}
        pendingCount={activePendingItems.length}
        role={role}
        token={token}
        showPrInfo={showPrInfo}
        showHelp={showHelp}
        prInfoBtnRef={prInfoBtnRef}
        prInfoRef={prInfoRef}
        helpBtnRef={helpBtnRef}
        helpRef={helpRef}
        onSelectPath={(path) => {
          setSelectedPath(path);
          setAnchor(null);
          setSelection(null);
          setBubblePos(null);
        }}
        onChangeViewMode={setViewMode}
        onAskSubmit={() => setShowSubmitConfirm(true)}
        onAskDiscardAll={() => setShowDiscardConfirm(true)}
        onTogglePrInfo={togglePrInfo}
        onToggleHelp={toggleHelp}
        onClearToken={() => {
          handleClearToken();
          closeHelp();
        }}
      />

      {loading ? <p className="notice notice--muted">Loading…</p> : null}
      {error ? <p className="notice notice--error">{error}</p> : null}
      {ref && !loading && !error && files.length === 0 ? (
        <p className="notice notice--muted">This PR has no changed .md files.</p>
      ) : null}

      <div className="layout">
        <SourceEditor
          cmRef={cmRef}
          source={source}
          cmExtensions={cmExtensions}
          viewMode={viewMode}
          onSourceChange={onSourceChange}
          onUpdate={(vu) => {
            if (suppressNextAnchor.current) return;
            handleSelectionUpdate(vu, setSelection);
          }}
          onClick={onEditorClick}
          onMouseDown={onEditorMouseDown}
          onMouseUp={onEditorMouseUp}
        />

        <ReviewSidebar
          sidebarRef={sidebarRef}
          reviewFilter={reviewFilter}
          counts={counts}
          onToggleFacet={toggleFacet}
          visibleEntries={visibleEntries}
          anchor={anchor}
          commentBody={commentBody}
          onChangeComposer={setCommentBody}
          onAddDraft={addDraft}
          onDiscardComposer={discardComposer}
          renderLiveSuggestion={renderLiveSuggestion}
          renderThread={renderThread}
        />
      </div>

      <SelectionBubble pos={bubblePos} onClick={openComposer} />

      {showSubmitConfirm ? (
        <SubmitConfirmModal
          items={activePendingItems}
          target={ref ?? undefined}
          onConfirm={role === "author" ? submitAuthor : submitReview}
          onCancel={() => setShowSubmitConfirm(false)}
          loading={loading}
          submitLabel={role === "author" ? "Submit" : undefined}
          prStatus={prStatus}
        />
      ) : null}

      {showDiscardConfirm ? (
        <DiscardAllConfirmModal
          count={activePendingItems.length}
          onConfirm={discardAllPending}
          onCancel={() => setShowDiscardConfirm(false)}
          loading={loading}
        />
      ) : null}

      <DebugFab
        show={showDebug}
        onToggle={toggleDebug}
        onClose={closeDebug}
        onRefresh={safeRefresh ? () => void safeRefresh() : undefined}
        role={role}
        viewMode={viewMode}
        headSha={headSha}
        edited={source !== baseSource}
        draftsCount={drafts.length}
        anchor={anchor}
        previewBody={previewBody}
        restored={restored}
      />

      {/* Development-only role switch (bottom-right); see BARK_DEV_ROLE_SWITCH. */}
      {DEV_ROLE_SWITCH ? <RoleFab role={role} onChangeRole={setRole} /> : null}
    </div>
  );
}
