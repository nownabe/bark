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
import { cmSelectionToAnchor } from "./cmAnchor";
import { commentHighlightField, commentHighlightTheme, setCommentHighlights } from "./highlight";
import { richMarkdown, richMarkdownTheme } from "./richMarkdown";
import { baseTextField, setBaseText, suggestDecorations, suggestTheme } from "./suggestMode";
import { setSuggestionMarks, suggestionMarksField, suggestionViewTheme } from "./suggestionView";
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
import { listDrafts, saveDrafts, type PendingDraft } from "../../lib/drafts";
import { clearToken, getToken, setToken as persistToken } from "../../lib/storage";
import { embedMetadata, extractMetadata, type CommentMetadata } from "../../lib/metadata";
import { sampleDoc } from "./sample";

type Role = "author" | "reviewer";
type ViewMode = "raw" | "preview";

interface Thread {
  id: string;
  comments: ExistingComment[];
  root: ExistingComment;
  path: string | undefined;
  pos: number;
}

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
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [suggestComment, setSuggestComment] = useState("");
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

  // Sort comments by position and group them into threads.
  const threads = useMemo<Thread[]>(() => {
    const map = new Map<string, ExistingComment[]>();
    for (const c of comments) {
      const key = c.meta?.thread || `solo:${c.source}:${c.id}`;
      const arr = map.get(key);
      if (arr) arr.push(c);
      else map.set(key, [c]);
    }
    const list: Thread[] = [...map.entries()].map(([id, cs]) => {
      const root = cs[0];
      const pos = root.meta
        ? root.meta.range.sl * 100000 + root.meta.range.sc
        : (root.line ?? 1e9) * 100000;
      return { id, comments: cs, root, path: root.meta?.path ?? root.path, pos };
    });
    const curPath = selectedPath ?? "sample";
    list.sort((a, b) => {
      const af = a.path === curPath ? 0 : 1;
      const bf = b.path === curPath ? 0 : 1;
      return af - bf || a.pos - b.pos;
    });
    return list;
  }, [comments, selectedPath]);

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
    const curPath = selectedPath ?? "sample";
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
    const curPath = selectedPath ?? "sample";
    const marks = comments
      .filter((c) => c.meta?.kind === "suggestion" && c.meta.path === curPath)
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
  }, [comments, source, lineStarts, headSha, selectedPath]);

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

  const routing = anchor
    ? isRangeInDiff(diffRanges, anchor.startLine, anchor.endLine)
      ? ({ kind: "review" } as const)
      : ({ kind: "issue" } as const)
    : null;

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

  const removeDraft = async (cidToRemove: string) => {
    const next = drafts.filter((d) => d.cid !== cidToRemove);
    setDrafts(next);
    if (ref) await saveDrafts(ref, next);
  };

  const submitReview = async () => {
    if (!client || !ref || drafts.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const reviewComments: ReviewCommentInput[] = [];
      const issueBodies: string[] = [];
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

  // Edit → suggestion (reviewer). Turn the line diff against base into suggestion
  // drafts (with an optional comment). After adding, reset the editor to base to
  // clear tracked changes (the suggestion is kept in pending).
  const addSuggestion = async () => {
    if (!ref || suggestionHunks.length === 0) return;
    const path = selectedPath ?? "sample";
    const body = suggestComment.trim() || "(suggested edit)";
    const newDrafts: PendingDraft[] = suggestionHunks.map((h) => {
      const inDiff = isRangeInDiff(diffRanges, h.sl, h.el);
      const id = crypto.randomUUID();
      return {
        cid: id,
        path,
        inDiff,
        range: { sl: h.sl, sc: 1, el: h.el, ec: 1 },
        quote: h.quote,
        sha: headSha ?? "",
        thread: id,
        body,
        kind: "suggestion",
        suggestion: h.replacement,
        permalink:
          !inDiff && headSha ? buildBlobPermalink(ref, path, headSha, h.sl, h.el) : undefined,
      };
    });
    const next = [...drafts, ...newDrafts];
    setDrafts(next);
    await saveDrafts(ref, next);
    setSuggestComment("");
    setSource(baseSource); // clear tracked changes (finalized as a suggestion)
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

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar__brand">Bark</span>
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
                {owner}/{repo} #{prNum} ↗
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
                <strong>reviewer</strong>: select text to comment. Editing the body records changes;
                add them as a suggestion from <strong>Suggestion</strong> on the right (optionally
                with a comment).
              </li>
              <li>
                Comments and suggestions queue in the same <strong>Pending</strong>; send them all
                with <strong>Submit review</strong>.
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
              }}
              onChange={(v) => setSource(v)}
              onUpdate={(vu) => {
                if (vu.selectionSet) {
                  const a = cmSelectionToAnchor(vu.state);
                  if (a) setAnchor(a);
                }
              }}
            />
          </div>
        </main>

        <aside className="sidebar">
          {/* composer (selection) */}
          {anchor ? (
            <section className="panel">
              <h2 className="panel__title">Comment</h2>
              {routing ? (
                <p className="composer__routing">
                  {routing.kind === "review" ? (
                    <span className="badge badge--review">review</span>
                  ) : (
                    <span className="badge badge--issue">issue + permalink</span>
                  )}{" "}
                  <span className="notice--muted">
                    L{anchor.startLine}
                    {anchor.endLine !== anchor.startLine ? `–L${anchor.endLine}` : ""}
                  </span>
                </p>
              ) : null}
              <textarea
                className="field"
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                rows={3}
                placeholder="Comment on the selected range"
              />
              <div className="composer__row">
                <button type="button" className="btn btn--primary btn--sm" onClick={addDraft}>
                  Add
                </button>
                <button type="button" className="btn btn--sm" onClick={() => setAnchor(null)}>
                  Cancel
                </button>
              </div>
            </section>
          ) : null}

          {/* suggestion (reviewer edits) */}
          {role === "reviewer" && suggestionHunks.length > 0 ? (
            <section className="panel">
              <h2 className="panel__title">Suggestion ({suggestionHunks.length})</h2>
              <p className="empty" style={{ marginBottom: 8 }}>
                Your edits become a suggestion. You can optionally add a comment.
              </p>
              <textarea
                className="field"
                value={suggestComment}
                onChange={(e) => setSuggestComment(e.target.value)}
                rows={2}
                placeholder="Comment (optional)"
              />
              <div className="composer__row">
                <button type="button" className="btn btn--primary btn--sm" onClick={addSuggestion}>
                  Add
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    setSource(baseSource);
                    setSuggestComment("");
                  }}
                >
                  Discard edits
                </button>
              </div>
            </section>
          ) : null}

          {/* pending drafts */}
          {ref ? (
            <section className="panel">
              <h2 className="panel__title">Pending ({drafts.length})</h2>
              {drafts.length === 0 ? (
                <p className="empty">No drafts.</p>
              ) : (
                <>
                  {drafts.map((d) => (
                    <div
                      key={d.cid}
                      className="thread thread--clickable"
                      onClick={() => jumpToDraft(d)}
                    >
                      <div className="comment__meta">
                        <span className={`badge badge--${d.inDiff ? "review" : "issue"}`}>
                          {d.inDiff ? "review" : "issue"}
                        </span>
                        {d.kind === "suggestion" ? (
                          <span className="badge badge--suggestion">suggestion</span>
                        ) : null}
                        <span>
                          {d.path} L{d.range.sl}
                          {d.range.el !== d.range.sl ? `–L${d.range.el}` : ""}
                        </span>
                      </div>
                      <div className="comment__body">{d.body}</div>
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
                  ))}
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={submitReview}
                    disabled={loading}
                    style={{ marginTop: 4 }}
                  >
                    Submit review ({drafts.length})
                  </button>
                </>
              )}
            </section>
          ) : null}

          {/* existing comments — position-sorted threads */}
          {ref ? (
            <section className="panel">
              <h2 className="panel__title">Comments ({comments.length})</h2>
              {threads.length === 0 ? (
                <p className="empty">No existing comments.</p>
              ) : (
                threads.map((t) => {
                  const st = statusFor(t.root);
                  const clickable = !!t.root.meta;
                  return (
                    <div
                      key={t.id}
                      className={clickable ? "thread thread--clickable" : "thread"}
                      onClick={clickable ? () => jumpTo(t.root) : undefined}
                    >
                      {t.root.meta ? (
                        <div className="thread__quote">{t.root.meta.quote}</div>
                      ) : null}
                      {t.comments.map((c, i) => (
                        <div key={`${c.source}-${c.id}`} className="comment">
                          <div className="comment__meta">
                            <span className="comment__author">@{c.author}</span>
                            <span>{c.source}</span>
                            {i === 0 && c.meta?.kind === "suggestion" ? (
                              <span className="badge badge--suggestion">suggestion</span>
                            ) : null}
                            {i === 0 && st && STATUS_LABEL[st] ? (
                              <span className={`badge badge--${st}`}>{STATUS_LABEL[st]}</span>
                            ) : null}
                            {i === 0 && !c.meta ? (
                              <span className="badge badge--issue">
                                {c.path ? `${c.path}:L${c.line ?? "?"}` : "no anchor"}
                              </span>
                            ) : null}
                          </div>
                          {c.meta?.kind === "suggestion" ? (
                            <>
                              {stripSuggestionBlock(c.body) ? (
                                <div className="comment__body">{stripSuggestionBlock(c.body)}</div>
                              ) : null}
                              <div className="sugg-old">{c.meta.quote}</div>
                              <div className="sugg-new">
                                {extractSuggestionBlock(c.body) || "(delete)"}
                              </div>
                            </>
                          ) : (
                            <div className="comment__body">{c.body || "(no body)"}</div>
                          )}
                        </div>
                      ))}
                      {t.root.meta ? (
                        <div className="comment__actions">
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
                })
              )}
            </section>
          ) : null}
        </aside>
      </div>

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
