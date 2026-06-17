// SPA shell — Design Doc §6.
// The document surface is CodeMirror 6 (always editable, source canonical §13),
// Obsidian-style Raw/Preview. Controls live in a sticky header; comments are
// position-sorted and threaded; debug info is collapsible.
import { useEffect, useMemo, useRef, useState } from "react";
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
import { SubmitConfirmModal } from "./components/SubmitConfirmModal";
import {
  buildPendingSuggestions,
  buildReviewEntries,
  buildThreads,
  filterReviewEntries,
  reviewCounts,
  type PendingSuggestion,
  type ReviewFilter,
  type ReviewThread,
} from "./reviewItems";
import { diffToSuggestions, extractSuggestionBlock, stripSuggestionBlock } from "../../lib/suggest";
import { buildLineIndex, lineColToOffset, type SourceAnchor } from "../../lib/anchor";
import { normalizeComments, type ExistingComment } from "../../lib/comments";
import { reanchorComment, type AnchorStatus } from "../../lib/reanchor";
import {
  buildBlobPermalink,
  buildSuggestionBlock,
  GitHubApiError,
  GitHubClient,
  type ChangedFile,
  type PrRef,
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

export function App() {
  const params = new URLSearchParams(window.location.search);
  const owner = params.get("owner");
  const repo = params.get("repo");
  const prNum = params.get("pr");
  const ref: PrRef | null = owner && repo && prNum ? { owner, repo, number: Number(prNum) } : null;

  const [token, setToken] = useState<string | null>(null);
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [tokenInput, setTokenInput] = useState("");

  const [files, setFiles] = useState<ChangedFile[]>([]);
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
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const cmRef = useRef<ReactCodeMirrorRef>(null);

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

  // Pending drafts + live suggestions + submitted threads in one sorted list.
  const threads = useMemo(() => buildThreads(comments, curPath), [comments, curPath]);
  const entries = useMemo(
    () => buildReviewEntries({ drafts, threads, pendingSuggestions, currentPath: curPath }),
    [drafts, threads, pendingSuggestions, curPath],
  );
  const counts = reviewCounts(entries);
  const pendingEntries = filterReviewEntries(entries, "pending");
  const visibleEntries = filterReviewEntries(entries, reviewFilter);

  useEffect(() => {
    getToken().then((t) => {
      setToken(t);
      setTokenLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!client || !ref) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const { headSha: sha, headRef: hr } = await client.getPull(ref);
        const md = await client.listMarkdownFiles(ref);
        if (cancelled) return;
        setHeadSha(sha);
        setHeadRef(hr);
        setFiles(md);
        setSelectedPath((prev) => prev ?? md[0]?.path ?? null);
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
  }, [client, ref?.owner, ref?.repo, ref?.number]);

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
      .filter((c) => c.meta && c.meta.path === curPath)
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
    const docLen = view.state.doc.length;
    const marks = comments
      .filter((c) => c.meta?.kind === "suggestion" && c.meta.path === curPath && !dismissed[c.id])
      .map((c) => {
        const r = reanchorComment(source, lineStarts, c.meta as CommentMetadata, headSha ?? "");
        return {
          from: r.startOffset,
          to: r.endOffset,
          status: r.status,
          replacement: extractSuggestionBlock(c.body) ?? "",
        };
      })
      .filter((m) => m.status !== "outdated" && m.from >= 0 && m.to <= docLen && m.from < m.to)
      .map(({ from, to, replacement }) => ({ from, to, replacement }));
    view.dispatch({ effects: setSuggestionMarks.of(marks) });
  }, [comments, source, lineStarts, headSha, selectedPath, dismissed]);

  const jumpTo = (c: ExistingComment) => {
    const view = cmRef.current?.view;
    if (!view || !c.meta) return;
    if (c.meta.path !== (selectedPath ?? "sample")) {
      setSelectedPath(c.meta.path);
      return;
    }
    const r = reanchorComment(source, lineStarts, c.meta, headSha ?? "");
    if (r.status === "outdated") return;
    view.dispatch({
      selection: { anchor: r.startOffset, head: r.endOffset },
      scrollIntoView: true,
    });
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

  // Thread reply: inherit the root's anchor and add a draft with the same thread id.
  const addReply = async (root: ExistingComment) => {
    if (!ref || !root.meta || !replyText.trim()) return;
    const m = root.meta;
    const ranges = parseRightRanges(files.find((f) => f.path === m.path)?.patch);
    const inDiff = isRangeInDiff(ranges, m.range.sl, m.range.el);
    const draft: PendingDraft = {
      cid: crypto.randomUUID(),
      path: m.path,
      inDiff,
      range: m.range,
      quote: m.quote,
      sha: headSha ?? m.sha,
      thread: m.thread,
      body: replyText.trim(),
      kind: "comment",
      permalink:
        !inDiff && headSha
          ? buildBlobPermalink(ref, m.path, headSha, m.range.sl, m.range.el)
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

  const saveToken = async () => {
    const t = tokenInput.trim();
    if (!t) return;
    await persistToken(t);
    setToken(t);
    setTokenInput("");
  };

  const handleClearToken = async () => {
    await clearToken();
    setToken(null);
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
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
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

  if (!tokenLoaded) return <p className="notice notice--muted">Loading…</p>;

  if (ref && !token) {
    return (
      <div className="gate">
        <h1>Bark</h1>
        <p>
          Opening {owner}/{repo} #{prNum} requires a GitHub fine-grained PAT.
        </p>
        <p className="notice--muted" style={{ fontSize: 13 }}>
          Issue a token with <code>Contents: Read and Write</code> /{" "}
          <code>Pull requests: Read and Write</code> for the target repository (§7.6). The token is
          stored only in <code>chrome.storage.local</code> and is never sent anywhere else (§9).
        </p>
        <input
          className="field"
          type="password"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="github_pat_..."
          style={{ marginBottom: 12 }}
        />
        <button type="button" className="btn btn--primary" onClick={saveToken}>
          Save and open
        </button>
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
  const lineRange = (r: { sl: number; el: number }) =>
    `L${r.sl}${r.el !== r.sl ? `–L${r.el}` : ""}`;

  const renderDraft = (d: PendingDraft) => (
    <div key={d.cid} className="thread thread--clickable" onClick={() => jumpToDraft(d)}>
      <div className="comment__meta">
        <span className="badge badge--pending">pending</span>
        <span>{lineRange(d.range)}</span>
      </div>
      {d.kind === "suggestion" ? (
        <>
          <div className="sugg-old">{d.quote}</div>
          <div className="sugg-new">{d.suggestion || "(delete)"}</div>
        </>
      ) : null}
      {d.body ? <div className="comment__body">{d.body}</div> : null}
      <div className="comment__actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={(e) => {
            e.stopPropagation();
            removeDraft(d.cid);
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );

  const renderLiveSuggestion = (s: PendingSuggestion) => (
    <div key={s.cid} className="thread">
      <div className="comment__meta">
        <span className="badge badge--pending">pending</span>
        <span>{lineRange(s.range)}</span>
      </div>
      <div className="sugg-old">{s.quote}</div>
      <div className="sugg-new">{s.replacement || "(delete)"}</div>
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
  );

  const renderThread = (t: ReviewThread) => {
    const st = statusFor(t.root);
    const clickable = !!t.root.meta;
    return (
      <div
        key={t.id}
        className={clickable ? "thread thread--clickable" : "thread"}
        onClick={clickable ? () => jumpTo(t.root) : undefined}
      >
        {t.root.meta ? <div className="thread__quote">{t.root.meta.quote}</div> : null}
        {t.comments.map((c, i) => (
          <div key={`${c.source}-${c.id}`} className="comment">
            <div className="comment__meta">
              <span className="comment__author">@{c.author}</span>
              {i === 0 && st && STATUS_LABEL[st] ? (
                <span className={`badge badge--${st}`}>{STATUS_LABEL[st]}</span>
              ) : null}
              {i === 0 && !c.meta ? (
                <span className="badge badge--issue">{c.line ? `L${c.line}` : "no anchor"}</span>
              ) : null}
            </div>
            {c.meta?.kind === "suggestion" ? (
              <>
                {stripSuggestionBlock(c.body) ? (
                  <div className="comment__body">{stripSuggestionBlock(c.body)}</div>
                ) : null}
                <div className="sugg-old">{c.meta.quote}</div>
                <div className="sugg-new">{extractSuggestionBlock(c.body) || "(delete)"}</div>
              </>
            ) : (
              <div className="comment__body">{c.body || "(no body)"}</div>
            )}
          </div>
        ))}
        {t.root.meta ? (
          <div className="comment__actions">
            {t.root.meta.kind === "suggestion" && role === "author" ? (
              dismissed[t.root.id] ? (
                <span className="notice--muted" style={{ fontSize: 11 }}>
                  {dismissed[t.root.id] === "accepted" ? "accepted — Commit to apply" : "rejected"}
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      acceptSuggestion(t.root);
                    }}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      rejectSuggestion(t.root);
                    }}
                  >
                    Reject
                  </button>
                </>
              )
            ) : null}
            <button
              type="button"
              className="btn btn--sm"
              onClick={(e) => {
                e.stopPropagation();
                setReplyTo(replyTo === t.id ? null : t.id);
                setReplyText("");
              }}
            >
              Reply
            </button>
          </div>
        ) : null}
        {replyTo === t.id ? (
          <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
            <textarea
              className="field"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              rows={2}
              placeholder="Reply (added to the same thread)"
            />
            <div className="composer__row">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => addReply(t.root)}
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
            <span className="topbar__meta">
              <a
                className="topbar__pr"
                href={`https://github.com/${owner}/${repo}/pull/${prNum}`}
                target="_blank"
                rel="noreferrer"
                title="Open this pull request on GitHub"
              >
                {owner}/{repo} #{prNum}
              </a>
              {headSha ? <span>@ {headSha.slice(0, 7)}</span> : null}
            </span>
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
            <div className="seg">
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
                disabled={loading || counts.pending === 0}
                title="Review the pending items before submitting"
              >
                Submit review ({counts.pending})
              </button>
            ) : null}
            <button
              type="button"
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
        {showHelp ? (
          <div className="popover" role="dialog">
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
            </ul>
            <div className="popover__footer">
              {token ? (
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
              ) : (
                <span />
              )}
              <button type="button" className="btn btn--sm" onClick={() => setShowHelp(false)}>
                Close
              </button>
            </div>
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
          <div className="doc">
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
              onUpdate={(vu) => handleSelectionUpdate(vu, setAnchor)}
            />
          </div>
        </main>

        <aside className="sidebar">
          {/* one list: the selection composer, pending items and submitted
              threads all live here — no separate comment / suggestion / review
              blocks. */}
          <section className="panel">
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
                e.kind === "draft"
                  ? renderDraft(e.draft)
                  : e.kind === "liveSuggestion"
                    ? renderLiveSuggestion(e.suggestion)
                    : renderThread(e.thread),
              )
            )}
          </section>
        </aside>
      </div>

      {showSubmitConfirm ? (
        <SubmitConfirmModal
          items={pendingEntries}
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
    </div>
  );
}
