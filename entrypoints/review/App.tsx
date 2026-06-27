// SPA shell — Design Doc §6.
// The document surface is CodeMirror 6 (always editable, source canonical §13),
// Obsidian-style Raw/Preview. Controls live in a sticky header; comments are
// position-sorted and threaded; debug info is collapsible.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
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
import { isSubmitChord } from "./keys";
import { SubmitConfirmModal } from "./components/SubmitConfirmModal";
import { DiscardAllConfirmModal } from "./components/DiscardAllConfirmModal";
import {
  buildAllPendingSuggestions,
  buildAuthorPendingItems,
  buildPendingItems,
  buildPendingSuggestions,
  buildReviewEntries,
  buildSuggestionMarks,
  buildThreads,
  deriveRole,
  filterReviewEntries,
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
  stripSuggestionBlock,
  suggestionEditRanges,
} from "../../lib/suggest";
import { buildLineIndex, lineColToOffset, type SourceAnchor } from "../../lib/anchor";
import { normalizeComments, reloadCommentsUntil, type ExistingComment } from "../../lib/comments";
import { reanchorComment, type AnchorStatus } from "../../lib/reanchor";
import {
  avatarUrl,
  buildBlobPermalink,
  buildSuggestionBlock,
  findThreadNodeId,
  GitHubClient,
  pullStatus,
  type PrRef,
  type ReviewCommentInput,
} from "../../lib/github";
import { isRangeInDiff, parseRightRanges } from "../../lib/diff";
import {
  clearAcceptedDecisions,
  discardAllDrafts,
  listSuggestionEdits,
  type PendingDraft,
  type SuggestionDecision,
} from "../../lib/drafts";
import { AuthorSubmitError, executeAuthorSubmit } from "../../lib/authorSubmit";
import { embedMetadata, extractMetadata, type CommentMetadata } from "../../lib/metadata";
import { browser } from "wxt/browser";
import { bootstrapPullRequest } from "../../lib/pr/bootstrap";
import type { PullRequestRepository } from "../../lib/pr/repository";
import { RepositoryProvider, useAppStateFromRepository } from "../../lib/pr/react";
import type { CommentView } from "../../lib/pr/appstate";
import { commentViewsToExisting } from "./adapters/commentViewsToExisting";
import { displayPositionToAnchorStatus } from "./adapters/displayPositionToAnchorStatus";
import { pendingDraftToComment } from "./adapters/pendingDraftToComment";
import { useAuthFlow } from "./hooks/useAuthFlow";
import { productionAuthDeps } from "./hooks/useAuthFlow.deps";
import { usePullRequestData } from "./hooks/usePullRequestData";
import { useDrafts } from "./hooks/useDrafts";
import { productionDraftsDeps } from "./hooks/useDrafts.deps";
import { useSuggestionEdits } from "./hooks/useSuggestionEdits";
import { productionSuggestionEditsDeps } from "./hooks/useSuggestionEdits.deps";
import { useDismissedSuggestions } from "./hooks/useDismissedSuggestions";
import { productionDismissedDeps } from "./hooks/useDismissedSuggestions.deps";
import { useSelectedFileContent } from "./hooks/useSelectedFileContent";
import { useUiPanels } from "./hooks/useUiPanels";
import { useThreadActions } from "./hooks/useThreadActions";
import { sampleDoc } from "./sample";
import { DEV_ROLE_SWITCH, errMessage, installUrl, STATUS_LABEL, type ViewMode } from "./uiHelpers";

export function App() {
  const params = new URLSearchParams(window.location.search);
  const owner = params.get("owner");
  const repo = params.get("repo");
  const prNum = params.get("pr");
  const ref: PrRef | null = owner && repo && prNum ? { owner, repo, number: Number(prNum) } : null;

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
  const client = useMemo(() => (token ? new GitHubClient(token) : null), [token]);
  const prData = usePullRequestData(client, ref);
  const {
    pull,
    files,
    headSha,
    headRef,
    viewerLogin,
    needsInstall,
    error,
    loading,
    reload: retryLoad,
    reset: resetPrData,
    setHeadSha,
    setLoading,
    setError,
  } = prData;

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
  // Legacy comments fetcher: the GitHub REST normaliser still owns the
  // submit-time read-after-write polling (reloadCommentsUntil). The
  // derived `comments` value below merges in foreign comments surfaced by
  // the new data layer — those couldn't be seen at all through the legacy
  // path because the normaliser doesn't carry foreign-id conventions.
  const [legacyComments, setLegacyComments] = useState<ExistingComment[]>([]);
  // Source of each commented file as of its createdAtSha, keyed `${sha}:${path}`,
  // so re-anchoring can diff against the exact revision a comment was made on
  // (lib/reanchor diff path). Populated lazily; a missing entry just means
  // re-anchoring falls back to quote search.
  const [oldSources, setOldSources] = useState<Record<string, string>>({});
  const draftsApi = useDrafts(ref, productionDraftsDeps);
  const { drafts, replaceAndPersist: replaceAndPersistDrafts, reset: resetDrafts } = draftsApi;
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
  const suggestionEditsApi = useSuggestionEdits(ref, productionSuggestionEditsDeps);
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
      onError: setError,
      onLoaded: ({ path, text, edit }) => {
        setSuggestionComments(edit?.comments ?? {});
        // Normalise the persisted entry against the fresh base so legacy
        // edits stored before `base` existed remain submittable.
        if (edit && edit.source !== text) {
          setSuggestionEdits((prev) => ({
            ...prev,
            [path]: { source: edit.source, base: text, comments: edit.comments ?? {} },
          }));
        }
      },
      onCleanup: () => {
        // Persist any pending edit before switching files / unmounting
        // so a quick reload right after an edit still restores it.
        void flushSuggestionEdits();
      },
    },
  );
  const { source, baseSource, setSource, setBaseSource } = fileSourceApi;
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

  // New data layer (lib/pr/) — phase L1 of the legacy-on-new-data-layer plan.
  // We bootstrap a Repository as soon as we have a token + PR ref so the
  // review tree can read from AppState in follow-up phases. Legacy data
  // paths are untouched; if bootstrap fails, the rest of App keeps working
  // through its own fetchers.
  const [prRepository, setPrRepository] = useState<PullRequestRepository | null>(null);
  useEffect(() => {
    if (!token || !ref) return;
    let cancelled = false;
    void (async () => {
      try {
        const { repository } = await bootstrapPullRequest({
          token,
          prRef: ref,
          storage: browser.storage.local,
        });
        if (!cancelled) setPrRepository(repository);
      } catch {
        // Silent — legacy App still works without the new data layer.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, ref?.owner, ref?.repo, ref?.number]);

  // L2 of the legacy-on-new-data-layer plan: read the Repository's AppState
  // and pull foreign comments (which the legacy normaliser can't see) into
  // the rendered comment list. Bark-authored ids still come through the
  // legacy fetcher — its read-after-write polling (reloadCommentsUntil)
  // remains the source of truth for the just-submitted path until L6.
  const deriveCtx = useMemo(() => ({ isInDiff: () => false }), []);
  const repositoryAppState = useAppStateFromRepository(prRepository, deriveCtx);
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
  const foreignFromAppState = useMemo(() => {
    if (!repositoryAppState) return [];
    // Bark's scope is line-bound markdown review (Design Doc §1). So
    // foreign comments we surface are limited to GitHub review comments
    // that DO have a line in the head (i.e. the diff-inside ones).
    // - issue comments (source === "issue")          → handled in GitHub
    // - review comments without a line (outdated)    → handled in GitHub
    return commentViewsToExisting(repositoryAppState.commentViews.values()).filter(
      (c) => c.meta === null && c.source === "review" && c.line !== undefined,
    );
  }, [repositoryAppState]);
  const comments = useMemo(() => {
    const seen = new Set(legacyComments.map((c) => c.id));
    return [...legacyComments, ...foreignFromAppState.filter((c) => !seen.has(c.id))];
  }, [legacyComments, foreignFromAppState]);

  const lineStarts = useMemo(() => buildLineIndex(source), [source]);
  const diffRanges = useMemo(
    () => parseRightRanges(files.find((f) => f.path === selectedPath)?.patch),
    [files, selectedPath],
  );
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
    return ext;
  }, [viewMode, role]);

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
      buildThreads(comments, drafts, curPath, { accepted: (id) => dismissed[id] === "accepted" }),
    [comments, drafts, curPath, dismissed],
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
  const oldSourceFor = (meta: CommentMetadata): string | undefined =>
    meta.sha ? oldSources[`${meta.sha}:${meta.path}`] : undefined;

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
        const r = reanchorComment(
          source,
          lineStarts,
          t.rootComment.meta,
          headSha ?? "",
          oldSourceFor(t.rootComment.meta),
        );
        if (r.status === "outdated") continue;
        from = r.startOffset;
        to = r.endOffset;
      } else if (t.rootDraft) {
        from = lineColToOffset(t.rootDraft.range.sl, t.rootDraft.range.sc, lineStarts);
        to = lineColToOffset(t.rootDraft.range.el, t.rootDraft.range.ec, lineStarts);
      } else {
        continue;
      }
      if (from >= 0 && to <= docLen && from < to) res.push({ id: t.id, from, to });
    }
    return res;
  }, [threads, visibleThreadIds, source, lineStarts, headSha, curPath, oldSources]);

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
  // Initial PR fetch (pull / files / head SHA + ref / viewer) now lives in
  // usePullRequestData. Pick the first file once the file list arrives, and
  // derive role once we know both the viewer and the PR author.
  useEffect(() => {
    if (files.length === 0) return;
    setSelectedPath((prev) => prev ?? files[0]?.path ?? null);
  }, [files]);
  useEffect(() => {
    if (viewerLogin && pull) setRole(deriveRole(viewerLogin, pull.author));
  }, [viewerLogin, pull]);

  // Per-file content load now lives in useSelectedFileContent.

  // Fetch the PR's review + issue comments and rebuild local state. Exposed as a
  // callback so actions that mutate comments on GitHub (resolve / reopen) can
  // refresh immediately instead of waiting for a full page reload.
  const reloadComments = useCallback(async () => {
    if (!client || !ref) return;
    const [reviews, issues] = await Promise.all([
      client.listReviewComments(ref),
      client.listIssueComments(ref),
    ]);
    setLegacyComments(normalizeComments(reviews, issues));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ref?.owner, ref?.repo, ref?.number]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!cancelled) await reloadComments();
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadComments]);

  // Fetch each commented file as of its createdAtSha so re-anchoring can diff
  // against the exact revision the comment was made on (Design Doc §7.8). Only
  // missing `${sha}:${path}` keys are fetched (cached across renders), and a
  // failed fetch is skipped so that comment falls back to quote search.
  useEffect(() => {
    if (!client || !ref || !headSha) return;
    const needed = new Map<string, { path: string; sha: string }>();
    for (const c of comments) {
      const m = c.meta;
      if (!m?.sha || !m.path || m.sha === headSha) continue;
      const key = `${m.sha}:${m.path}`;
      if (!(key in oldSources)) needed.set(key, { path: m.path, sha: m.sha });
    }
    if (needed.size === 0) return;
    let cancelled = false;
    (async () => {
      const fetched: Record<string, string> = {};
      await Promise.all(
        [...needed].map(async ([key, { path, sha }]) => {
          try {
            fetched[key] = await client.getFileContent(ref, path, sha);
          } catch {
            /* leave unset → re-anchoring falls back to quote search */
          }
        }),
      );
      if (!cancelled && Object.keys(fetched).length > 0) {
        setOldSources((prev) => ({ ...prev, ...fetched }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments, client, headSha, ref?.owner, ref?.repo, ref?.number]);

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
    const existing = comments
      // Suggestions render via their own strikethrough/insert view, not the plain
      // comment highlight — don't double up.
      .filter(
        (c) =>
          c.meta &&
          c.meta.path === curPath &&
          c.meta.kind !== "suggestion" &&
          !c.meta.event &&
          visibleThreadIds.has(c.meta.thread),
      )
      .map((c) =>
        reanchorComment(
          source,
          lineStarts,
          c.meta as CommentMetadata,
          headSha ?? "",
          oldSourceFor(c.meta as CommentMetadata),
        ),
      )
      .filter((r) => r.status !== "outdated")
      .map((r) => ({ from: r.startOffset, to: r.endOffset }))
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
  }, [comments, drafts, visibleThreadIds, source, lineStarts, headSha, selectedPath, oldSources]);

  // Render submitted suggestions in the body as tracked changes (old = strikethrough / new = green block).
  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    const marks = buildSuggestionMarks({
      comments,
      source,
      lineStarts,
      headSha: headSha ?? "",
      currentPath: curPath,
      dismissed,
      oldSources,
    });
    view.dispatch({ effects: setSuggestionMarks.of(marks) });
  }, [comments, source, lineStarts, headSha, selectedPath, dismissed, oldSources]);

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
    const r = reanchorComment(source, lineStarts, c.meta, headSha ?? "", oldSourceFor(c.meta));
    if (r.status === "outdated") return;
    suppressNextAnchor.current = true;
    view.dispatch({
      selection: { anchor: r.startOffset, head: r.endOffset },
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
    if (!anchor || !ref) return;
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
    const next = [...drafts, draft];
    await replaceAndPersistDrafts(next);
    // L4: also push to the new data layer's LocalState so a future
    // repository.submitDrafts() (L6) finds the same draft. Double-write
    // only for now; legacy useDrafts still owns the rendered list.
    if (prRepository) {
      await prRepository.upsertComment(pendingDraftToComment(draft, viewerLogin ?? "you"));
    }
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

  // Thread reply: inherit the thread's anchor (from its first submitted comment,
  // else its first pending draft) and add a draft with the same thread id.
  const addReply = async (thread: ReviewThread) => {
    if (!ref || !replyText.trim()) return;
    const a = thread.rootComment?.meta
      ? {
          path: thread.rootComment.meta.path,
          range: thread.rootComment.meta.range,
          quote: thread.rootComment.meta.quote,
          thread: thread.rootComment.meta.thread,
          sha: thread.rootComment.meta.sha,
        }
      : thread.rootDraft
        ? {
            path: thread.rootDraft.path,
            range: thread.rootDraft.range,
            quote: thread.rootDraft.quote,
            thread: thread.rootDraft.thread,
            sha: thread.rootDraft.sha,
          }
        : null;
    if (!a) return;
    const ranges = parseRightRanges(files.find((f) => f.path === a.path)?.patch);
    const inDiff = isRangeInDiff(ranges, a.range.sl, a.range.el);
    const draft: PendingDraft = {
      cid: crypto.randomUUID(),
      path: a.path,
      inDiff,
      range: a.range,
      quote: a.quote,
      sha: headSha ?? a.sha,
      thread: a.thread,
      body: replyText.trim(),
      kind: "comment",
      permalink:
        !inDiff && headSha
          ? buildBlobPermalink(ref, a.path, headSha, a.range.sl, a.range.el)
          : undefined,
    };
    const next = [...drafts, draft];
    await replaceAndPersistDrafts(next);
    // L6a: also push to Repository's LocalState so a future
    // repository.submitDrafts() emits a CreateReply step. The Reconciler
    // needs parentLocalId (the LocalId of the thread's root Comment) —
    // resolve it via commentViewByRemoteId when the root is a submitted
    // comment we already track in AppState. Reply drafts whose parent
    // is itself a draft (rootDraft only) stay legacy-only this round.
    if (prRepository && thread.rootComment) {
      const rootView = commentViewByRemoteId.get(thread.rootComment.id);
      const parentLocalId = rootView?.comment.id;
      if (parentLocalId) {
        await prRepository.upsertComment(
          pendingDraftToComment(draft, viewerLogin ?? "you", parentLocalId),
        );
      }
    }
    cancelReply();
  };

  const toggleFacet = (f: ReviewFacet) =>
    setReviewFilter((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  // Two paths share the same UI affordance:
  //  - Bark-authored thread (root.meta exists): route through Repository.
  //    setThreadResolved (L6b) — the Reconciler flips Thread.resolved and
  //    the Executor calls GraphQL resolveReviewThread / unresolveReviewThread
  //    once the sync cycle runs. No legacy marker-comment is posted any
  //    more (ADR 0001 §3 puts resolved state on the Thread entity, not in
  //    a comment body). Falls back to legacy if Repository isn't ready.
  //  - Foreign in-diff review thread (root present, meta null, line known):
  //    flip GitHub's native resolve only. No marker comment to post —
  //    there's no Bark identity to point at.
  // Both finish with a reload so the new resolved state is visible.
  const setThreadResolved = async (t: ReviewThread, resolved: boolean) => {
    if (!client || !ref) return;
    const root = t.rootComment;
    if (!root) return;
    setResolvingId(t.id);
    setError(null);
    try {
      if (root.meta) {
        // ---- Bark-authored path (A) -------------------------------------
        if (prRepository) {
          await prRepository.setThreadResolved(t.id, resolved);
        } else if (headSha) {
          // Pre-bootstrap fallback: legacy marker comment + GraphQL.
          const evMeta: CommentMetadata = {
            cid: crypto.randomUUID(),
            path: root.meta.path,
            range: root.meta.range,
            quote: root.meta.quote,
            sha: headSha,
            thread: t.id,
            kind: "comment",
            event: resolved ? "resolve" : "unresolve",
          };
          const body = embedMetadata(
            resolved ? "Resolved via Bark." : "Reopened via Bark.",
            evMeta,
          );
          if (root.source === "review") {
            await client.replyToReviewComment(ref, root.id, body);
            const nodeId = findThreadNodeId(await client.listReviewThreads(ref), root.id);
            if (nodeId) {
              if (resolved) await client.resolveReviewThread(nodeId);
              else await client.unresolveReviewThread(nodeId);
            }
          } else {
            await client.createIssueComment(ref, body);
          }
        }
      } else if (root.source === "review") {
        // ---- Foreign review path (B) ------------------------------------
        const nodeId = findThreadNodeId(await client.listReviewThreads(ref), root.id);
        if (!nodeId) {
          setError("Could not find the GitHub review thread for this comment.");
          return;
        }
        if (resolved) await client.resolveReviewThread(nodeId);
        else await client.unresolveReviewThread(nodeId);
      } else {
        // Issue comments (D) are filtered out in L3a; nothing to do.
        return;
      }
      // Refresh comments now so the thread's resolved state reflects immediately
      // (the reloadKey path only reloads PR info/files, not comments).
      await reloadComments();
    } catch (e) {
      setError(errMessage(e));
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
    if (!c.meta) return;
    const newSource = applyAcceptedSuggestion({
      source,
      lineStarts,
      meta: c.meta,
      replacement: extractSuggestionBlock(c.body) ?? "",
      headSha: headSha ?? "",
      oldSource: oldSourceFor(c.meta),
    });
    if (newSource === null) return; // can't locate the target text anymore
    setSource(newSource);
    persistSuggestionEdit(curPath, newSource, baseSource, suggestionComments);
    await setDecision(c.id, "accepted");
  };

  const rejectSuggestion = async (c: ExistingComment) => {
    await setDecision(c.id, "rejected");
  };

  const removeDraft = async (cidToRemove: string) => {
    const next = drafts.filter((d) => d.cid !== cidToRemove);
    await replaceAndPersistDrafts(next);
    // L4: keep Repository's LocalState in sync.
    if (prRepository) await prRepository.discardComment(cidToRemove);
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
        sha: headSha ?? "",
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

  const submitReview = async () => {
    if (!client || !ref) return;
    const toSubmit = [...drafts, ...suggestionsToDrafts()];
    if (toSubmit.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      // L6c: route in-diff drafts through Repository (new write path),
      // keep out-of-diff drafts on the legacy fetcher because their body
      // composition (quoted block + permalink) is a Bark-specific UX
      // extension that lives outside the new layer's Comment.body
      // contract (ADR 0001 §3: body is the visible body only). Posting
      // out-of-diff via Repository would lose the quote/permalink hint.
      const inDiffDrafts = toSubmit.filter((d) => d.inDiff);
      const outOfDiffDrafts = toSubmit.filter((d) => !d.inDiff);

      // ---- in-diff: Repository.submitDrafts ---------------------------
      if (prRepository && inDiffDrafts.length > 0) {
        const inRepo = new Set(prRepository.getLocalState().comments.map((c) => c.id));
        for (const d of inDiffDrafts) {
          if (inRepo.has(d.cid)) continue; // already double-written by L4/L6a
          const body =
            d.kind === "suggestion"
              ? `${d.body}\n\n${buildSuggestionBlock(d.suggestion ?? "")}`
              : d.body;
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
        await prRepository.submitDrafts();
      } else if (inDiffDrafts.length > 0) {
        // Pre-bootstrap fallback: legacy in-diff submit.
        const reviewComments: ReviewCommentInput[] = inDiffDrafts.map((d) => {
          const suggestion =
            d.kind === "suggestion" ? `\n\n${buildSuggestionBlock(d.suggestion ?? "")}` : "";
          const dmeta: CommentMetadata = {
            cid: d.cid,
            path: d.path,
            range: d.range,
            quote: d.quote,
            sha: d.sha,
            thread: d.thread,
            kind: d.kind,
          };
          return {
            path: d.path,
            side: "RIGHT" as const,
            line: d.range.el,
            ...(d.range.el !== d.range.sl
              ? { start_line: d.range.sl, start_side: "RIGHT" as const }
              : {}),
            body: embedMetadata(`${d.body}${suggestion}`, dmeta),
          };
        });
        await client.submitReview(ref, {
          commitId: headSha ?? undefined,
          comments: reviewComments,
        });
      }

      // ---- out-of-diff: legacy path with the rich quoted body ---------
      for (const d of outOfDiffDrafts) {
        const suggestion =
          d.kind === "suggestion" ? `\n\n${buildSuggestionBlock(d.suggestion ?? "")}` : "";
        const quoted = d.quote
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n");
        const note =
          d.kind === "suggestion"
            ? "\n\n(Out of diff: this suggestion will not show an Apply button.)"
            : "";
        const visible =
          `${d.body}${suggestion}${note}\n\n${quoted}\n${d.permalink ?? ""}`.trimEnd();
        const dmeta: CommentMetadata = {
          cid: d.cid,
          path: d.path,
          range: d.range,
          quote: d.quote,
          sha: d.sha,
          thread: d.thread,
          kind: d.kind,
        };
        await client.createIssueComment(ref, embedMetadata(visible, dmeta));
      }
      await replaceAndPersistDrafts([]);
      setSource(baseSource); // live suggestion edits are now submitted
      setSuggestionComments({});
      // All files' suggestions just went out, so drop every persisted edit
      // (not only the open file's) and cancel any debounced write that would
      // revive them.
      await discardAllPersistedEdits();
      // GitHub's GET .../comments can momentarily omit comments a just-completed
      // POST .../reviews created (read-after-write lag), which left the
      // just-submitted items invisible until the next reload. Poll until every
      // submitted cid is back before rebuilding the list.
      const submittedCids = toSubmit.map((d) => d.cid);
      const comments = await reloadCommentsUntil(async () => {
        const [reviews, issues] = await Promise.all([
          client.listReviewComments(ref),
          client.listIssueComments(ref),
        ]);
        return normalizeComments(reviews, issues);
      }, submittedCids);
      setLegacyComments(comments);
      // The pending items just became submitted; if the list was filtered to
      // "Pending" it would now look empty, so make sure "submitted" is on —
      // without forcing the user's "resolved" preference on.
      setReviewFilter(revealSubmittedFacets);
      setEmphasizedThreadId(null);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
      setShowSubmitConfirm(false);
    }
  };

  // Build a commit message for the author Submit. The summary states the
  // aggregate; the body lists each accepted suggestion (path:line) and edited
  // path so a reader of `git log` can see exactly what landed.
  const buildAuthorCommitMessage = (
    editedPaths: string[],
    accepted: AcceptedSuggestionInfo[],
  ): string => {
    const fileWord = editedPaths.length === 1 ? "file" : "files";
    const acceptWord = accepted.length === 1 ? "accepted suggestion" : "accepted suggestions";
    const summary =
      accepted.length > 0
        ? `docs: update ${editedPaths.length} ${fileWord} via Bark (${accepted.length} ${acceptWord})`
        : `docs: update ${editedPaths.length} ${fileWord} via Bark`;
    const acceptLines = accepted.map((a) => `- accept suggestion at ${a.path}:L${a.line}`);
    const editLines = editedPaths.map((p) => `- edit ${p}`);
    const body = [...acceptLines, ...editLines].join("\n");
    return body ? `${summary}\n\n${body}` : summary;
  };

  // Author Submit: flush every staged action together.
  //   1) Post in-diff comments as one review, out-of-diff as PR comments,
  //      replies into their existing threads (replyToReviewComment).
  //   2) Make ONE commit on the PR head ref covering every edited file +
  //      every accepted suggestion's applied source.
  //   3) Resolve the accepted suggestions' threads.
  // Errors are stage-aware: a comment-stage failure leaves edits + dismissed
  // intact; a commit-stage failure (e.g. 422 non-fast-forward) leaves *all*
  // pending state intact so the author can retry without losing work.
  const submitAuthor = async () => {
    if (!client || !ref || !headRef || !headSha) return;
    setLoading(true);
    setError(null);
    try {
      // Drafts → comments / replies. A draft is a reply when its thread id
      // matches an existing submitted comment's thread (and its own cid !==
      // thread, i.e. it isn't the new-thread root).
      const submittedByThread = new Map<string, ExistingComment[]>();
      for (const c of comments) {
        if (!c.meta?.thread) continue;
        const list = submittedByThread.get(c.meta.thread);
        if (list) list.push(c);
        else submittedByThread.set(c.meta.thread, [c]);
      }
      const reviewComments: ReviewCommentInput[] = [];
      const issueBodies: string[] = [];
      const replies: { rootCommentId: number; body: string }[] = [];
      for (const d of drafts) {
        const dmeta: CommentMetadata = {
          cid: d.cid,
          path: d.path,
          range: d.range,
          quote: d.quote,
          sha: d.sha,
          thread: d.thread,
          kind: d.kind,
        };
        const existing = submittedByThread.get(d.thread);
        if (existing && existing.length > 0 && d.cid !== d.thread) {
          // Reply to an existing thread — post via the Reply API so it nests
          // natively on GitHub. Embed metadata so Bark's own reconstruction
          // stays consistent.
          const root = [...existing].sort((a, b) => a.id - b.id)[0];
          replies.push({ rootCommentId: root.id, body: embedMetadata(d.body, dmeta) });
          continue;
        }
        const suggestion =
          d.kind === "suggestion" ? `\n\n${buildSuggestionBlock(d.suggestion ?? "")}` : "";
        if (d.inDiff) {
          reviewComments.push({
            path: d.path,
            side: "RIGHT",
            line: d.range.el,
            ...(d.range.el !== d.range.sl
              ? { start_line: d.range.sl, start_side: "RIGHT" as const }
              : {}),
            body: embedMetadata(`${d.body}${suggestion}`, dmeta),
          });
        } else {
          const quoted = d.quote
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n");
          const note =
            d.kind === "suggestion"
              ? "\n\n(Out of diff: this suggestion will not show an Apply button.)"
              : "";
          const visible =
            `${d.body}${suggestion}${note}\n\n${quoted}\n${d.permalink ?? ""}`.trimEnd();
          issueBodies.push(embedMetadata(visible, dmeta));
        }
      }

      // Files: every persisted edit where source !== base, content sorted by path.
      const files = Object.entries(suggestionEdits)
        .filter(
          ([, e]) =>
            typeof e?.base === "string" && typeof e?.source === "string" && e.source !== e.base,
        )
        .map(([path, e]) => ({ path, content: e.source }))
        .sort((a, b) => a.path.localeCompare(b.path));

      // Look up thread node ids for the accepted suggestions (one round trip)
      // and compose the Bark resolve-event metadata reply for each. The reply
      // mirrors setThreadResolved's body so the local sidebar still treats the
      // thread as resolved after Submit clears the dismissed map.
      const acceptedCommentsById = new Map(comments.map((c) => [c.id, c]));
      const acceptedThreads: {
        rootCommentId: number;
        threadNodeId: string;
        eventBody: (newHeadSha: string) => string;
      }[] = [];
      const resolvedCommentIds: number[] = [];
      if (acceptedSuggestionInfos.length > 0) {
        const threadInfos = await client.listReviewThreads(ref);
        for (const info of acceptedSuggestionInfos) {
          const nodeId = findThreadNodeId(threadInfos, info.commentId);
          const root = acceptedCommentsById.get(info.commentId);
          if (!nodeId || !root?.meta) continue;
          const evMeta: CommentMetadata = {
            cid: crypto.randomUUID(),
            path: root.meta.path,
            range: root.meta.range,
            quote: root.meta.quote,
            sha: headSha,
            thread: root.meta.thread,
            kind: "comment",
            event: "resolve",
          };
          acceptedThreads.push({
            rootCommentId: info.commentId,
            threadNodeId: nodeId,
            // Reference the commit that applied the suggestion so the reply
            // is useful as audit trail. GitHub auto-renders the raw sha as a
            // commit link. When no commit ran (no-op accept), fall back to
            // the plain marker so the resolve-event still posts.
            eventBody: (newHeadSha) => {
              const body =
                newHeadSha !== headSha
                  ? `Applied via Bark in ${newHeadSha}.`
                  : "Resolved via Bark.";
              return embedMetadata(body, { ...evMeta, sha: newHeadSha });
            },
          });
          resolvedCommentIds.push(info.commentId);
        }
      }

      const commitMessage = buildAuthorCommitMessage(
        files.map((f) => f.path),
        acceptedSuggestionInfos,
      );

      const result = await executeAuthorSubmit({
        client,
        ref,
        branch: headRef,
        baseSha: headSha,
        reviewComments,
        issueBodies,
        replies,
        files,
        commitMessage,
        acceptedThreads,
      });

      // Cleanup: drop drafts, persisted edits, and the just-applied accepted
      // decisions (rejected entries persist — they keep the suggestion hidden).
      await replaceAndPersistDrafts([]);
      await discardAllPersistedEdits();
      if (resolvedCommentIds.length > 0) {
        await clearAcceptedDecisions(ref, resolvedCommentIds);
        setDismissed((prev) => {
          const drop = new Set(resolvedCommentIds.map((id) => String(id)));
          const next: Record<string, SuggestionDecision> = {};
          for (const [k, v] of Object.entries(prev)) {
            if (v === "accepted" && drop.has(k)) continue;
            next[k] = v;
          }
          return next;
        });
      }

      // Advance to the new head sha and refetch the open file (anchors shift).
      if (result.newHeadSha !== headSha) {
        setHeadSha(result.newHeadSha);
        if (selectedPath) {
          const newText = await client.getFileContent(ref, selectedPath, result.newHeadSha);
          setSource(newText);
          setBaseSource(newText);
          setSuggestionComments({});
        }
      }

      // Refresh comments so just-posted threads + resolves are visible. Poll
      // until any submitted cids re-appear (GitHub read-after-write lag).
      const submittedCids = [
        ...reviewComments.map((c) => extractMetadata(c.body).meta?.cid),
        ...issueBodies.map((b) => extractMetadata(b).meta?.cid),
      ].filter((id): id is string => Boolean(id));
      const fresh = await reloadCommentsUntil(async () => {
        const [reviews, issues] = await Promise.all([
          client.listReviewComments(ref),
          client.listIssueComments(ref),
        ]);
        return normalizeComments(reviews, issues);
      }, submittedCids);
      setLegacyComments(fresh);
      setReviewFilter(revealSubmittedFacets);
      setEmphasizedThreadId(null);

      if (result.resolveErrors.length > 0) {
        setError(
          `Submitted, but failed to resolve ${result.resolveErrors.length} thread(s). Reopen the PR to retry.`,
        );
      }
    } catch (e) {
      if (e instanceof AuthorSubmitError) {
        if (e.stage === "commit") {
          setError(
            `Commit failed: ${e.message}. The branch may have new commits — refresh and try again. Your pending changes are kept.`,
          );
        } else {
          setError(`${e.stage} failed: ${e.message}`);
        }
      } else {
        setError(errMessage(e));
      }
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
    resetPrData();
    resetDrafts();
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
    setSource(v);
    persistSuggestionEdit(curPath, v, baseSource, suggestionComments);
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
    // L4: discard the same draft cids in Repository's LocalState (top-
    // level new-comment drafts only — replies go through L6).
    const localCids = drafts.map((d) => d.cid);
    resetDrafts();
    setSource(baseSource);
    setSuggestionComments({});
    resetSuggestionEdits();
    if (ref) await discardAllDrafts(ref);
    if (prRepository) {
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
    persistSuggestionEdit(curPath, source, baseSource, next);
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
    if (replyTo !== hit.id) startReply(hit.id);
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
    if (sHit)
      emphasizeSuggestion(sHit.cid, false); // text already clicked; just emphasize the item
    else setEmphasizedThreadId(null); // clicked away from any comment → drop emphasis
  };

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
  // the user into the review UI with a confusing "Not Found" notice (§7.6).
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
    // L5: prefer the new layer's displayPosition (it already does the LCS
    // re-anchor under the hood, with strict quote matching). Fall back to
    // the legacy reanchorComment when AppState hasn't seen this remoteId
    // yet (bootstrap in flight, or a draft that hasn't been submitted) —
    // that keeps the badge stable across bootstrap.
    const view = commentViewByRemoteId.get(c.id);
    if (view) return displayPositionToAnchorStatus(view.displayPosition);
    return reanchorComment(source, lineStarts, c.meta, headSha ?? "", oldSourceFor(c.meta)).status;
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
  const openThread = (t: ReviewThread) => {
    jumpToThread(t);
    setEmphasizedThreadId(t.id);
    if (replyTo !== t.id) startReply(t.id);
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

  const renderSubmittedMessage = (
    c: ExistingComment,
    isRoot: boolean,
    st: AnchorStatus | null,
    actions?: ReactNode,
  ) => (
    <div key={`s-${c.source}-${c.id}`} className="comment">
      <div className="comment__meta">
        <img
          className="comment__avatar"
          src={avatarUrl(c.author, 40)}
          alt=""
          width={18}
          height={18}
          loading="lazy"
        />
        <span className="comment__author">{c.author}</span>
        {isRoot && st && STATUS_LABEL[st] ? (
          <span className={`badge badge--${st}`}>{STATUS_LABEL[st]}</span>
        ) : null}
        {isRoot && !c.meta ? (
          <span className="badge badge--issue">{c.line ? `L${c.line}` : "no anchor"}</span>
        ) : null}
        {actions ? <span className="comment__meta-actions">{actions}</span> : null}
      </div>
      {c.meta?.kind === "suggestion" ? (
        <>
          {stripSuggestionBlock(c.body) ? (
            <div className="comment__body">{stripSuggestionBlock(c.body)}</div>
          ) : null}
          <SuggestionDiff
            before={c.meta.quote ?? ""}
            after={extractSuggestionBlock(c.body) ?? ""}
          />
        </>
      ) : (
        <div className="comment__body">{c.body || "(no body)"}</div>
      )}
    </div>
  );

  const renderPendingMessage = (d: PendingDraft) => (
    <div key={`p-${d.cid}`} className="comment comment--pending">
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
            removeDraft(d.cid);
          }}
        >
          ✕
        </button>
      </div>
      {d.kind === "suggestion" ? (
        <SuggestionDiff before={d.quote} after={d.suggestion ?? ""} />
      ) : (
        <div className="comment__body">{d.body || "(no body)"}</div>
      )}
    </div>
  );

  const renderThread = (t: ReviewThread) => {
    const root = t.rootComment;
    const st = root ? statusFor(root) : null;
    const showAuthorActions = root?.meta?.kind === "suggestion" && role === "author";
    // Resolvable when:
    //  - A: Bark-authored thread (root.meta present), not via accepted-suggestion
    //  - B: foreign in-diff review thread (root.meta null, source review). L3a's
    //    filter already kept only diff-inside foreign reviews; there's a
    //    GitHub-native reviewThread we can resolve via GraphQL.
    // Reopen is offered only when resolution came from an event, not from
    // accepting a suggestion (which resolves implicitly).
    const acceptedRoot = root?.meta?.kind === "suggestion" && dismissed[root.id] === "accepted";
    const isBarkAuthored = Boolean(root?.meta);
    const isForeignReviewRoot = !!root && !root.meta && root.source === "review";
    const canResolve = (isBarkAuthored || isForeignReviewRoot) && t.hasSubmitted && !acceptedRoot;
    // Resolve/Reopen sits at the right end of the root comment's author row.
    const resolveAction = canResolve ? (
      <button
        type="button"
        className="thread__resolve"
        disabled={resolvingId === t.id}
        onClick={(e) => {
          e.stopPropagation();
          void setThreadResolved(t, !t.resolved);
        }}
      >
        {resolvingId === t.id
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
          emphasizedThreadId === t.id ? " thread--emphasized" : ""
        }`}
        onClick={() => openThread(t)}
      >
        {t.quote ? <div className="thread__quote">{t.quote}</div> : null}
        {t.messages.map((m) =>
          m.kind === "submitted"
            ? renderSubmittedMessage(
                m.comment,
                m.comment === root,
                st,
                m.comment === root ? resolveAction : undefined,
              )
            : renderPendingMessage(m.draft),
        )}
        {showAuthorActions && root ? (
          <div className="comment__actions" onClick={(e) => e.stopPropagation()}>
            {dismissed[root.id] ? (
              <span className="notice--muted" style={{ fontSize: 11 }}>
                {dismissed[root.id] === "accepted" ? "accepted — Submit to apply" : "rejected"}
              </span>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => acceptSuggestion(root)}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => rejectSuggestion(root)}
                >
                  Reject
                </button>
              </>
            )}
          </div>
        ) : null}
        {replyTo === t.id ? (
          <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
            <textarea
              className="field"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (isSubmitChord(e)) {
                  e.preventDefault();
                  addReply(t);
                }
              }}
              rows={2}
              placeholder="Reply"
              autoFocus
            />
            <div className="composer__row">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => addReply(t)}
              >
                Add
              </button>
              <button type="button" className="btn btn--sm" onClick={cancelReply}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const reviewTree = (
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

  // Phase L1: when the new-data-layer Repository is ready, wrap the tree
  // so descendants can call useAppState / useRepository. Before bootstrap
  // completes the tree still renders — it just doesn't have the provider
  // yet, which is fine because nothing inside reads from it today.
  return prRepository ? (
    <RepositoryProvider repo={prRepository}>{reviewTree}</RepositoryProvider>
  ) : (
    reviewTree
  );
}
