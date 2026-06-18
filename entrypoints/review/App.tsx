// SPA shell — Design Doc §6.
// The document surface is CodeMirror 6 (always editable, source canonical §13),
// Obsidian-style Raw/Preview. Controls live in a sticky header; comments are
// position-sorted and threaded; debug info is collapsible.
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";
import { EditorView } from "@codemirror/view";
import { handleSelectionUpdate } from "./cmAnchor";
import { commentHighlightField, commentHighlightTheme, setCommentHighlights } from "./highlight";
import { richMarkdown, richMarkdownTheme } from "./richMarkdown";
import { baseTextField, setBaseText, suggestDecorations, suggestTheme } from "./suggestMode";
import { setSuggestionMarks, suggestionMarksField, suggestionViewTheme } from "./suggestionView";
import { SelectionComposer } from "./components/SelectionComposer";
import { SuggestionDiff } from "./components/SuggestionDiff";
import { isSubmitChord } from "./keys";
import { SubmitConfirmModal } from "./components/SubmitConfirmModal";
import {
  buildPendingItems,
  buildPendingSuggestions,
  buildReviewEntries,
  buildSuggestionMarks,
  buildThreads,
  filterReviewEntries,
  reviewEntryCounts,
  threadRangeAt,
  type PendingSuggestion,
  type ReviewFilter,
  type ReviewThread,
  type ThreadRange,
} from "./reviewItems";
import {
  diffToSuggestions,
  extractSuggestionBlock,
  stripSuggestionBlock,
  suggestionEditRanges,
} from "../../lib/suggest";
import { buildLineIndex, lineColToOffset, type SourceAnchor } from "../../lib/anchor";
import { normalizeComments, type ExistingComment } from "../../lib/comments";
import { reanchorComment, type AnchorStatus } from "../../lib/reanchor";
import {
  avatarUrl,
  buildBlobPermalink,
  buildSuggestionBlock,
  GitHubApiError,
  GitHubClient,
  pullStatus,
  type ChangedFile,
  type PrRef,
  type PullInfo,
  type PullStatus,
  type ReviewCommentInput,
} from "../../lib/github";
import { isRangeInDiff, parseRightRanges } from "../../lib/diff";
import {
  listDismissedSuggestions,
  listDrafts,
  saveDismissedSuggestions,
  saveDrafts,
  type PendingDraft,
  type SuggestionDecision,
} from "../../lib/drafts";
import { clearToken, getToken, setToken as persistToken } from "../../lib/storage";
import { pollForToken, requestDeviceAuthorization, type DeviceAuthorization } from "../../lib/auth";
import { embedMetadata, extractMetadata, type CommentMetadata } from "../../lib/metadata";
import { sampleDoc } from "./sample";

type Role = "author" | "reviewer";
type ViewMode = "raw" | "preview";

function errMessage(e: unknown): string {
  if (e instanceof GitHubApiError) {
    if (e.status === 401 || e.status === 403) {
      return `Authentication error (${e.status}). Check the token's permissions/expiry.`;
    }
    if (e.status === 404) return "Not Found (404). Check the repository / PR / token permissions.";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

// Show only states that are meaningful to the user (current = normal is hidden).
const STATUS_LABEL: Partial<Record<AnchorStatus, string>> = {
  reanchored: "position shifted",
  outdated: "position not found",
};

const PR_STATUS_LABEL: Record<PullStatus, string> = {
  open: "Open",
  merged: "Merged",
  draft: "Draft",
  closed: "Closed",
};

// The author/reviewer switch is a development aid only. It renders as a floating
// control bottom-right exclusively in builds where BARK_DEV_ROLE_SWITCH is set;
// normal builds hide it and keep the default role.
const DEV_ROLE_SWITCH = Boolean(import.meta.env.BARK_DEV_ROLE_SWITCH);

// Public slug of the Bark GitHub App; used to build its install URL so a 404/403
// (likely "not installed on this repo") can offer a one-click install (§7.6).
const APP_SLUG = import.meta.env.BARK_GITHUB_APP_SLUG;
const installUrl = APP_SLUG ? `https://github.com/apps/${APP_SLUG}/installations/new` : null;

export function App() {
  const params = new URLSearchParams(window.location.search);
  const owner = params.get("owner");
  const repo = params.get("repo");
  const prNum = params.get("pr");
  const ref: PrRef | null = owner && repo && prNum ? { owner, repo, number: Number(prNum) } : null;

  const [token, setToken] = useState<string | null>(null);
  const [tokenLoaded, setTokenLoaded] = useState(false);
  // Device-flow auth state (§7.6): the pending grant + transient UI status.
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthorization | null>(null);
  const [authStarting, setAuthStarting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // Set when the initial repo/PR load fails with 404/403 — most often the GitHub
  // App is not installed on this repository; we show a dedicated install gate.
  const [needsInstall, setNeedsInstall] = useState(false);
  // Bumped to re-run the initial load (e.g. after the user installs the App).
  const [reloadKey, setReloadKey] = useState(0);

  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [pull, setPull] = useState<PullInfo | null>(null);
  const [headSha, setHeadSha] = useState<string | null>(null);
  const [headRef, setHeadRef] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [source, setSource] = useState<string>(ref ? "" : sampleDoc);
  const [baseSource, setBaseSource] = useState<string>(ref ? "" : sampleDoc);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [role, setRole] = useState<Role>("reviewer");
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [anchor, setAnchor] = useState<SourceAnchor | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [comments, setComments] = useState<ExistingComment[]>([]);
  const [drafts, setDrafts] = useState<PendingDraft[]>([]);
  const [dismissed, setDismissed] = useState<Record<string, SuggestionDecision>>({});
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  // Per-suggestion attached comment, keyed by live suggestion cid (`live:sl:el`).
  const [suggestionComments, setSuggestionComments] = useState<Record<string, string>>({});
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [emphasizedThreadId, setEmphasizedThreadId] = useState<string | null>(null);
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [showPrInfo, setShowPrInfo] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const prInfoRef = useRef<HTMLDivElement>(null);
  const prInfoBtnRef = useRef<HTMLButtonElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);
  const helpBtnRef = useRef<HTMLButtonElement>(null);
  // The pending-suggestion ids seen on the previous render, so a newly created
  // suggestion can be scrolled into view in the review list (see effect below).
  const seenSuggestionCids = useRef<Set<string>>(new Set());
  // Set before a programmatic "jump to item" selection so the resulting
  // selection update does not pop the new-comment composer (we are highlighting
  // an existing item, not starting a new comment).
  const suppressNextAnchor = useRef(false);

  const client = useMemo(() => (token ? new GitHubClient(token) : null), [token]);
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

  // Threads (submitted comments + pending replies merged) + live suggestions,
  // in one sorted list.
  const threads = useMemo(
    () => buildThreads(comments, drafts, curPath),
    [comments, drafts, curPath],
  );
  const entries = useMemo(
    () => buildReviewEntries({ threads, pendingSuggestions, currentPath: curPath }),
    [threads, pendingSuggestions, curPath],
  );
  const counts = reviewEntryCounts(entries);
  const prStatus = pull ? pullStatus(pull) : null;
  const pendingItems = buildPendingItems(drafts, pendingSuggestions);
  const visibleEntries = filterReviewEntries(entries, reviewFilter);

  // Highlighted span of each thread on the current file, so clicking commented
  // text in the body can map back to its thread.
  const threadRanges = useMemo<ThreadRange[]>(() => {
    const docLen = source.length;
    const res: ThreadRange[] = [];
    for (const t of threads) {
      if (t.path !== curPath) continue;
      let from: number;
      let to: number;
      if (t.rootComment?.meta) {
        const r = reanchorComment(source, lineStarts, t.rootComment.meta, headSha ?? "");
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
  }, [threads, source, lineStarts, headSha, curPath]);

  // The current-doc char span of each pending suggestion's edited text, so a
  // click on the suggested text in the editor maps back to its review item. The
  // ranges align by index with pendingSuggestions (same hunk order).
  const suggestionRanges = useMemo<{ cid: string; from: number; to: number }[]>(() => {
    if (role !== "reviewer" || source === baseSource) return [];
    return suggestionEditRanges(baseSource, source)
      .map((r, k) => ({ cid: pendingSuggestions[k]?.cid, from: r.from, to: r.to }))
      .filter((r): r is { cid: string; from: number; to: number } => Boolean(r.cid));
  }, [role, source, baseSource, pendingSuggestions]);

  // Surface an error from the initial load and flag the likely "app not
  // installed" case (404/403) so we can route to the dedicated install gate.
  const reportError = (e: unknown) => {
    setError(errMessage(e));
    setNeedsInstall(e instanceof GitHubApiError && (e.status === 404 || e.status === 403));
  };
  const retryLoad = () => setReloadKey((k) => k + 1);

  // Dismiss the PR details popover on a click outside it (and outside its toggle).
  useEffect(() => {
    if (!showPrInfo) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (prInfoRef.current?.contains(t) || prInfoBtnRef.current?.contains(t)) return;
      setShowPrInfo(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showPrInfo]);

  // Same for the help popover: a click outside it (and outside the ? toggle) closes it.
  useEffect(() => {
    if (!showHelp) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (helpRef.current?.contains(t) || helpBtnRef.current?.contains(t)) return;
      setShowHelp(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showHelp]);

  useEffect(() => {
    getToken().then((t) => {
      setToken(t);
      setTokenLoaded(true);
    });
  }, []);

  // Starting a fresh selection (new-comment composer) means focus moved off the
  // emphasized item, so drop the emphasis. Programmatic jump/emphasis selections
  // set suppressNextAnchor and never set `anchor`, so they don't trigger this.
  useEffect(() => {
    if (anchor) setEmphasizedThreadId(null);
  }, [anchor]);

  // Device-flow polling (§7.6): once a grant exists, poll GitHub at its interval
  // until the user authorizes (or the code expires / is denied). A self-scheduling
  // timeout lets us honor `slow_down` by widening the gap.
  useEffect(() => {
    if (!deviceAuth) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let delay = deviceAuth.interval * 1000;
    const deadline = Date.now() + deviceAuth.expiresIn * 1000;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() > deadline) {
        setAuthError("The code expired before you authorized. Please try again.");
        setDeviceAuth(null);
        return;
      }
      try {
        const r = await pollForToken(deviceAuth.deviceCode);
        if (cancelled) return;
        if (r.kind === "authorized") {
          await persistToken(r.token);
          setToken(r.token);
          setDeviceAuth(null);
          return;
        }
        if (r.kind === "slow_down") delay = r.interval * 1000;
      } catch (e) {
        if (cancelled) return;
        setAuthError(e instanceof Error ? e.message : String(e));
        setDeviceAuth(null);
        return;
      }
      timer = setTimeout(tick, delay);
    };

    timer = setTimeout(tick, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deviceAuth]);

  useEffect(() => {
    if (!client || !ref) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNeedsInstall(false);
    (async () => {
      try {
        const info = await client.getPull(ref);
        const md = await client.listMarkdownFiles(ref);
        if (cancelled) return;
        setPull(info);
        setHeadSha(info.headSha);
        setHeadRef(info.headRef);
        setFiles(md);
        setSelectedPath((prev) => prev ?? md[0]?.path ?? null);
      } catch (e) {
        if (!cancelled) reportError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ref?.owner, ref?.repo, ref?.number, reloadKey]);

  useEffect(() => {
    if (!client || !ref || !headSha || !selectedPath) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const text = await client.getFileContent(ref, selectedPath, headSha);
        if (!cancelled) {
          setSource(text);
          setBaseSource(text);
        }
      } catch (e) {
        if (!cancelled) setError(errMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, headSha, selectedPath, ref?.owner, ref?.repo, ref?.number]);

  useEffect(() => {
    if (!client || !ref) return;
    let cancelled = false;
    (async () => {
      try {
        const [reviews, issues] = await Promise.all([
          client.listReviewComments(ref),
          client.listIssueComments(ref),
        ]);
        if (!cancelled) setComments(normalizeComments(reviews, issues));
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ref?.owner, ref?.repo, ref?.number]);

  useEffect(() => {
    if (ref) listDrafts(ref).then(setDrafts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.owner, ref?.repo, ref?.number]);

  // author's accept/reject decisions on submitted suggestions (R3).
  useEffect(() => {
    if (ref) listDismissedSuggestions(ref).then(setDismissed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.owner, ref?.repo, ref?.number]);

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
    const existing = comments
      // Suggestions render via their own strikethrough/insert view, not the plain
      // comment highlight — don't double up.
      .filter((c) => c.meta && c.meta.path === curPath && c.meta.kind !== "suggestion")
      .map((c) => reanchorComment(source, lineStarts, c.meta as CommentMetadata, headSha ?? ""))
      .filter((r) => r.status !== "outdated")
      .map((r) => ({ from: r.startOffset, to: r.endOffset }))
      .filter(clip);
    const pending = drafts
      .filter((d) => d.path === curPath)
      .map((d) => ({
        from: lineColToOffset(d.range.sl, d.range.sc, lineStarts),
        to: lineColToOffset(d.range.el, d.range.ec, lineStarts),
        pending: true,
      }))
      .filter(clip);
    view.dispatch({ effects: setCommentHighlights.of([...existing, ...pending]) });
  }, [comments, drafts, source, lineStarts, headSha, selectedPath]);

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
    });
    view.dispatch({ effects: setSuggestionMarks.of(marks) });
  }, [comments, source, lineStarts, headSha, selectedPath, dismissed]);

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
    const r = reanchorComment(source, lineStarts, c.meta, headSha ?? "");
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
    setDrafts(next);
    await saveDrafts(ref, next);
    setCommentBody("");
    collapseSelection(); // deselect; the pending highlight stays
    setAnchor(null);
  };

  const discardComposer = () => {
    setCommentBody("");
    collapseSelection();
    setAnchor(null);
  };

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
    setDrafts(next);
    await saveDrafts(ref, next);
    setReplyText("");
    setReplyTo(null);
  };

  // author: record an accept/reject decision on a submitted suggestion.
  const setDecision = async (id: number, decision: SuggestionDecision) => {
    const next = { ...dismissed, [id]: decision };
    setDismissed(next);
    if (ref) await saveDismissedSuggestions(ref, next);
  };

  // author: accept a suggestion by applying its replacement to the source (then Commit).
  const acceptSuggestion = async (c: ExistingComment) => {
    if (!c.meta) return;
    const replacement = extractSuggestionBlock(c.body) ?? "";
    const r = reanchorComment(source, lineStarts, c.meta, headSha ?? "");
    if (r.status === "outdated") return; // can't locate the target text anymore
    setSource(source.slice(0, r.startOffset) + replacement + source.slice(r.endOffset));
    await setDecision(c.id, "accepted");
  };

  const rejectSuggestion = async (c: ExistingComment) => {
    await setDecision(c.id, "rejected");
  };

  const removeDraft = async (cidToRemove: string) => {
    const next = drafts.filter((d) => d.cid !== cidToRemove);
    setDrafts(next);
    if (ref) await saveDrafts(ref, next);
  };

  // Materialize the reviewer's live suggestion edits into real drafts at submit
  // time (they are kept "live" in the editor until then; task 4).
  const suggestionsToDrafts = (): PendingDraft[] =>
    pendingSuggestions.map((s) => {
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
      const reviewComments: ReviewCommentInput[] = [];
      const issueBodies: string[] = [];
      for (const d of toSubmit) {
        const dmeta: CommentMetadata = {
          cid: d.cid,
          path: d.path,
          range: d.range,
          quote: d.quote,
          sha: d.sha,
          thread: d.thread,
          kind: d.kind,
        };
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
      if (reviewComments.length > 0) {
        await client.submitReview(ref, {
          commitId: headSha ?? undefined,
          comments: reviewComments,
        });
      }
      for (const body of issueBodies) {
        await client.createIssueComment(ref, body);
      }
      setDrafts([]);
      await saveDrafts(ref, []);
      setSource(baseSource); // live suggestion edits are now submitted
      setSuggestionComments({});
      const [reviews, issues] = await Promise.all([
        client.listReviewComments(ref),
        client.listIssueComments(ref),
      ]);
      setComments(normalizeComments(reviews, issues));
      // The pending items just became submitted; if the list was filtered to
      // "Pending" it would now look empty, so reveal everything.
      setReviewFilter("all");
      setEmphasizedThreadId(null);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
      setShowSubmitConfirm(false);
    }
  };

  const commitEdit = async () => {
    if (!client || !ref || !selectedPath || !headRef) return;
    setLoading(true);
    setError(null);
    try {
      const blobSha = await client.getFileSha(ref, selectedPath, headRef);
      await client.putFileContent(ref, {
        path: selectedPath,
        content: source,
        message: `docs: edit ${selectedPath} via Bark`,
        sha: blobSha,
        branch: headRef,
      });
      const { headSha: sha } = await client.getPull(ref);
      setHeadSha(sha);
      const newText = await client.getFileContent(ref, selectedPath, sha);
      setSource(newText);
      setBaseSource(newText);
      const [reviews, issues] = await Promise.all([
        client.listReviewComments(ref),
        client.listIssueComments(ref),
      ]);
      setComments(normalizeComments(reviews, issues));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  };

  // Begin the device flow: ask GitHub for a user code, then render it; the
  // polling effect below takes over once `deviceAuth` is set.
  const startDeviceFlow = async () => {
    setAuthError(null);
    setAuthStarting(true);
    try {
      setDeviceAuth(await requestDeviceAuthorization());
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuthStarting(false);
    }
  };

  const handleClearToken = async () => {
    await clearToken();
    setToken(null);
    setDeviceAuth(null);
    setAuthError(null);
    setFiles([]);
    setHeadSha(null);
    setSelectedPath(null);
    setSource(ref ? "" : sampleDoc);
    setBaseSource(ref ? "" : sampleDoc);
    setAnchor(null);
  };

  const discardEdits = () => {
    setSource(baseSource);
    setSuggestionComments({});
  };

  const setSuggestionComment = (cid: string, value: string) => {
    setSuggestionComments((prev) => ({ ...prev, [cid]: value }));
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

  // Click commented (highlighted) text in the body → select that comment's range,
  // emphasize its thread in the sidebar, and open its reply box (so it behaves
  // like clicking the thread itself, not like starting a new comment).
  const emphasizeThread = (hit: ThreadRange) => {
    const view = cmRef.current?.view;
    if (!view) return;
    suppressNextAnchor.current = true;
    view.dispatch({ selection: { anchor: hit.from, head: hit.to } });
    suppressNextAnchor.current = false; // update listener already ran synchronously
    if (!visibleEntries.some((e) => e.kind === "thread" && e.thread.id === hit.id)) {
      setReviewFilter("all"); // make sure the emphasized thread is visible
    }
    setEmphasizedThreadId(hit.id);
    if (replyTo !== hit.id) {
      setReplyTo(hit.id);
      setReplyText("");
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
      setReviewFilter("all"); // make sure the emphasized suggestion is visible
    }
    setEmphasizedThreadId(cid);
    setReplyTo(null);
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
      <div className="gate">
        <div className="gate__brand">
          <img className="gate__logo" src="/icon/128.png" alt="" />
          <h1>Bark</h1>
        </div>
        {deviceAuth ? (
          <>
            <p>
              Authorize Bark for {owner}/{repo} #{prNum}. Enter this code on GitHub:
            </p>
            <div className="device-code">{deviceAuth.userCode}</div>
            <div className="gate__actions">
              <a
                className="btn btn--primary"
                href={deviceAuth.verificationUri}
                target="_blank"
                rel="noreferrer"
              >
                Open GitHub
              </a>
              <button
                type="button"
                className="btn"
                onClick={() => void navigator.clipboard?.writeText(deviceAuth.userCode)}
              >
                Copy code
              </button>
            </div>
            <p className="notice--muted" style={{ fontSize: 13 }}>
              Pick the repositories Bark may access, then approve. Keep this tab open — it continues
              automatically once you authorize.
            </p>
          </>
        ) : (
          <>
            <p>
              Opening {owner}/{repo} #{prNum} requires access to GitHub. Authorize Bark with the
              device flow — there's no token to copy by hand.
            </p>
            <p className="notice--muted" style={{ fontSize: 13 }}>
              You choose which repositories Bark can access (<code>Contents</code> /{" "}
              <code>Pull requests</code>, §7.6). The resulting token is stored only in{" "}
              <code>chrome.storage.local</code> and is never sent anywhere else (§9).
            </p>
            {authError && (
              <p className="notice--error" style={{ fontSize: 13 }}>
                {authError}
              </p>
            )}
            <button
              type="button"
              className="btn btn--primary"
              onClick={startDeviceFlow}
              disabled={authStarting}
            >
              {authStarting ? "Starting…" : "Connect GitHub"}
            </button>
          </>
        )}
      </div>
    );
  }

  // Authorized, but the initial load failed with 404/403 — almost always the
  // App isn't installed on this repo. Show a dedicated gate instead of dropping
  // the user into the review UI with a confusing "Not Found" notice (§7.6).
  if (ref && needsInstall) {
    return (
      <div className="gate">
        <div className="gate__brand">
          <img className="gate__logo" src="/icon/128.png" alt="" />
          <h1>Bark</h1>
        </div>
        <p>
          Bark can't open {owner}/{repo} #{prNum} yet.
        </p>
        <p className="notice--muted" style={{ fontSize: 13 }}>
          You're authorized, but Bark isn't installed on this repository (or the repository / PR
          doesn't exist). Install Bark and select this repository, then retry.
        </p>
        <div className="gate__actions">
          {installUrl ? (
            <a className="btn btn--primary" href={installUrl} target="_blank" rel="noreferrer">
              Install on this repository
            </a>
          ) : null}
          <button type="button" className="btn" onClick={retryLoad} disabled={loading}>
            {loading ? "Checking…" : "Retry"}
          </button>
        </div>
        <p className="notice--muted" style={{ fontSize: 12 }}>
          Authorized as the wrong account?{" "}
          <button type="button" className="linkish" onClick={handleClearToken}>
            Use a different account
          </button>
        </p>
      </div>
    );
  }

  const statusFor = (c: ExistingComment): AnchorStatus | null => {
    if (!c.meta || c.meta.path !== (selectedPath ?? "sample")) return null;
    return reanchorComment(source, lineStarts, c.meta, headSha ?? "").status;
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
    if (replyTo !== t.id) {
      setReplyTo(t.id);
      setReplyText("");
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

  const renderSubmittedMessage = (c: ExistingComment, isRoot: boolean, st: AnchorStatus | null) => (
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
    return (
      <div
        key={t.id}
        data-thread-id={t.id}
        className={`thread thread--clickable${
          emphasizedThreadId === t.id ? " thread--emphasized" : ""
        }`}
        onClick={() => openThread(t)}
      >
        {t.quote ? <div className="thread__quote">{t.quote}</div> : null}
        {t.messages.map((m) =>
          m.kind === "submitted"
            ? renderSubmittedMessage(m.comment, m.comment === root, st)
            : renderPendingMessage(m.draft),
        )}
        {showAuthorActions && root ? (
          <div className="comment__actions" onClick={(e) => e.stopPropagation()}>
            {dismissed[root.id] ? (
              <span className="notice--muted" style={{ fontSize: 11 }}>
                {dismissed[root.id] === "accepted" ? "accepted — Commit to apply" : "rejected"}
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
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  setReplyTo(null);
                  setReplyText("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar__brand">
          <img className="topbar__logo" src="/icon/128.png" alt="" />
          Bark
        </span>
        {ref ? (
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
                    onClick={() => setShowPrInfo((v) => !v)}
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
                onChange={(e) => {
                  setSelectedPath(e.target.value);
                  setAnchor(null);
                }}
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
                onClick={() => setViewMode("preview")}
              >
                Preview
              </button>
              <button
                type="button"
                aria-pressed={viewMode === "raw"}
                className="seg--dark"
                onClick={() => setViewMode("raw")}
              >
                Raw
              </button>
            </div>
            {role === "author" && selectedPath ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={commitEdit}
                disabled={loading}
              >
                Commit
              </button>
            ) : null}
            {role === "reviewer" ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setShowSubmitConfirm(true)}
                disabled={loading || pendingItems.length === 0}
                title="Review the pending items from all files before submitting"
              >
                Submit review ({pendingItems.length})
              </button>
            ) : null}
            <button
              type="button"
              ref={helpBtnRef}
              className="help-btn"
              title="Help"
              aria-label="Help"
              onClick={() => setShowHelp((v) => !v)}
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
                <strong>author</strong>: edit the body and <strong>Commit</strong>. Select text to
                comment.
              </li>
              <li>
                <strong>reviewer</strong>: select text to comment. Editing the body is queued
                automatically as a suggestion (optionally annotate it with a comment).
              </li>
              <li>
                Pending and submitted items share one list; filter it from the list header. Send all
                pending items with <strong>Submit review</strong> in the top bar — you confirm them
                first.
              </li>
              <li>
                Click a side item to jump to and highlight its place in the body. You can reply
                within a thread.
              </li>
              <li>
                Press <strong>⌘/Ctrl+Enter</strong> in a comment or reply box to add it (same as the
                Add button).
              </li>
            </ul>
            {token ? (
              <div className="popover__footer">
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  onClick={() => {
                    handleClearToken();
                    setShowHelp(false);
                  }}
                >
                  Delete token
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </header>

      {loading ? <p className="notice notice--muted">Loading…</p> : null}
      {error ? <p className="notice notice--error">{error}</p> : null}
      {ref && !loading && !error && files.length === 0 ? (
        <p className="notice notice--muted">This PR has no changed .md files.</p>
      ) : null}

      <div className="layout">
        <main>
          <div className="doc" onClick={onEditorClick}>
            <CodeMirror
              ref={cmRef}
              value={source}
              extensions={cmExtensions}
              basicSetup={{
                lineNumbers: viewMode === "raw",
                foldGutter: viewMode === "raw",
                highlightSelectionMatches: false,
                highlightActiveLine: false,
                highlightActiveLineGutter: false,
              }}
              onChange={(v) => setSource(v)}
              onUpdate={(vu) => {
                if (suppressNextAnchor.current) return;
                handleSelectionUpdate(vu, setAnchor);
              }}
            />
          </div>
        </main>

        <aside className="sidebar" ref={sidebarRef}>
          {/* one list: the selection composer, pending items and submitted
              threads all live here — no separate comment / suggestion / review
              blocks. */}
          <section className="panel panel--bare">
            <div className="panel__head">
              <h2 className="panel__title">Review</h2>
              <div className="seg seg--sm">
                {(["all", "pending", "submitted"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={reviewFilter === f}
                    onClick={() => setReviewFilter(f)}
                  >
                    {f === "all" ? "All" : f === "pending" ? "Pending" : "Sent"} ({counts[f]})
                  </button>
                ))}
              </div>
            </div>
            {anchor ? (
              <SelectionComposer
                anchor={anchor}
                value={commentBody}
                onChange={setCommentBody}
                onAdd={addDraft}
                onDiscard={discardComposer}
              />
            ) : null}
            {visibleEntries.length === 0 && !anchor ? (
              <p className="empty">No items.</p>
            ) : (
              visibleEntries.map((e) =>
                e.kind === "liveSuggestion"
                  ? renderLiveSuggestion(e.suggestion)
                  : renderThread(e.thread),
              )
            )}
          </section>
        </aside>
      </div>

      {showSubmitConfirm ? (
        <SubmitConfirmModal
          items={pendingItems}
          target={ref ?? undefined}
          onConfirm={submitReview}
          onCancel={() => setShowSubmitConfirm(false)}
          loading={loading}
        />
      ) : null}

      {/* floating debug (left-bottom) */}
      <button
        type="button"
        className="debug-fab"
        title="Debug info"
        aria-label="Debug info"
        onClick={() => setShowDebug((v) => !v)}
      >
        🐛
      </button>
      {showDebug ? (
        <div className="debug-popover debug" role="dialog">
          <div className="composer__row" style={{ justifyContent: "space-between", marginTop: 0 }}>
            <strong>Debug</strong>
            <button type="button" className="btn btn--sm" onClick={() => setShowDebug(false)}>
              Close
            </button>
          </div>
          <dl>
            <dt>role / view</dt>
            <dd>
              {role} / {viewMode}
            </dd>
            <dt>head</dt>
            <dd>{headSha ? headSha.slice(0, 7) : "-"}</dd>
            <dt>edited</dt>
            <dd>{source !== baseSource ? "yes" : "no"}</dd>
            <dt>drafts</dt>
            <dd>{drafts.length}</dd>
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

      {/* Development-only role switch (bottom-right); see BARK_DEV_ROLE_SWITCH. */}
      {DEV_ROLE_SWITCH ? (
        <div className="role-fab" role="group" aria-label="Role (development)">
          <span className="role-fab__label">dev</span>
          <div className="seg seg--sm">
            <button
              type="button"
              aria-pressed={role === "author"}
              onClick={() => setRole("author")}
            >
              author
            </button>
            <button
              type="button"
              aria-pressed={role === "reviewer"}
              onClick={() => setRole("reviewer")}
            >
              reviewer
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
