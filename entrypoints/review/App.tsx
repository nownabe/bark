// SPA shell — Design Doc §6.
// ドキュメント面は CodeMirror 6(常時編集可、ソース正準 §13)。Obsidian 風 Raw/Preview。
// 固定ヘッダに操作集約、コメントは位置順 + スレッド化、デバッグ情報は折りたたみ。
import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { GFM } from '@lezer/markdown';
import { EditorView } from '@codemirror/view';
import { cmSelectionToAnchor } from './cmAnchor';
import { commentHighlightField, commentHighlightTheme, setCommentHighlights } from './highlight';
import { richMarkdown, richMarkdownTheme } from './richMarkdown';
import { baseTextField, setBaseText, suggestDecorations, suggestTheme } from './suggestMode';
import { diffToSuggestions } from '../../lib/suggest';
import { buildLineIndex, type SourceAnchor } from '../../lib/anchor';
import { normalizeComments, type ExistingComment } from '../../lib/comments';
import { reanchorComment, type AnchorStatus } from '../../lib/reanchor';
import {
  buildBlobPermalink,
  buildSuggestionBlock,
  GitHubApiError,
  GitHubClient,
  type ChangedFile,
  type PrRef,
  type ReviewCommentInput,
} from '../../lib/github';
import { isRangeInDiff, parseRightRanges } from '../../lib/diff';
import { listDrafts, saveDrafts, type PendingDraft } from '../../lib/drafts';
import { clearToken, getToken, setToken as persistToken } from '../../lib/storage';
import { embedMetadata, extractMetadata, type CommentMetadata } from '../../lib/metadata';
import { sampleDoc } from './sample';

type Role = 'author' | 'reviewer';
type ViewMode = 'raw' | 'preview';

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
      return `認証エラー (${e.status})。トークンの権限/有効期限を確認してください。`;
    }
    if (e.status === 404) return 'Not Found (404)。リポジトリ/PR/トークン権限を確認してください。';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

const STATUS_LABEL: Record<AnchorStatus, string> = {
  current: 'anchored',
  reanchored: '再アンカー',
  outdated: '位置不明',
};

export function App() {
  const params = new URLSearchParams(window.location.search);
  const owner = params.get('owner');
  const repo = params.get('repo');
  const prNum = params.get('pr');
  const ref: PrRef | null =
    owner && repo && prNum ? { owner, repo, number: Number(prNum) } : null;

  const [token, setToken] = useState<string | null>(null);
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [tokenInput, setTokenInput] = useState('');

  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [headSha, setHeadSha] = useState<string | null>(null);
  const [headRef, setHeadRef] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [source, setSource] = useState<string>(ref ? '' : sampleDoc);
  const [baseSource, setBaseSource] = useState<string>(ref ? '' : sampleDoc);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [role, setRole] = useState<Role>('reviewer');
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [anchor, setAnchor] = useState<SourceAnchor | null>(null);
  const [commentBody, setCommentBody] = useState('');
  const [kind, setKind] = useState<'comment' | 'suggestion'>('comment');
  const [suggestionText, setSuggestionText] = useState('');
  const [comments, setComments] = useState<ExistingComment[]>([]);
  const [drafts, setDrafts] = useState<PendingDraft[]>([]);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const cmRef = useRef<ReactCodeMirrorRef>(null);

  const client = useMemo(() => (token ? new GitHubClient(token) : null), [token]);
  const lineStarts = useMemo(() => buildLineIndex(source), [source]);
  const diffRanges = useMemo(
    () => parseRightRanges(files.find((f) => f.path === selectedPath)?.patch),
    [files, selectedPath],
  );
  const cmExtensions = useMemo(() => {
    const ext = [
      markdown({ extensions: [GFM], codeLanguages: languages }),
      EditorView.lineWrapping,
      commentHighlightField,
      commentHighlightTheme,
      baseTextField,
    ];
    if (viewMode === 'preview') ext.push(richMarkdown, richMarkdownTheme);
    if (role === 'reviewer') ext.push(suggestDecorations, suggestTheme);
    return ext;
  }, [viewMode, role]);

  // コメントを位置順に整列し thread でグループ化
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
    const curPath = selectedPath ?? 'sample';
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

  // tracked-changes 用に base テキストを CM へ反映(reviewer サジェスト)
  useEffect(() => {
    cmRef.current?.view?.dispatch({ effects: setBaseText.of(baseSource) });
  }, [baseSource]);

  // コメントアンカーを CM 本文にハイライト(R6)
  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    const ranges = comments
      .filter((c) => c.meta && c.meta.path === (selectedPath ?? 'sample'))
      .map((c) => reanchorComment(source, lineStarts, c.meta as CommentMetadata, headSha ?? ''))
      .filter((r) => r.status !== 'outdated' && r.endOffset > r.startOffset)
      .map((r) => ({ from: r.startOffset, to: r.endOffset }));
    view.dispatch({ effects: setCommentHighlights.of(ranges) });
  }, [comments, source, lineStarts, headSha, selectedPath]);

  const jumpTo = (c: ExistingComment) => {
    const view = cmRef.current?.view;
    if (!view || !c.meta) return;
    if (c.meta.path !== (selectedPath ?? 'sample')) {
      setSelectedPath(c.meta.path);
      return;
    }
    const r = reanchorComment(source, lineStarts, c.meta, headSha ?? '');
    if (r.status === 'outdated') return;
    view.dispatch({ selection: { anchor: r.startOffset, head: r.endOffset }, scrollIntoView: true });
    view.focus();
  };

  const effectiveKind = role === 'reviewer' ? kind : 'comment';
  const meta: CommentMetadata | null = anchor
    ? {
        cid: 'preview',
        path: selectedPath ?? 'sample',
        range: { sl: anchor.startLine, sc: anchor.startCol, el: anchor.endLine, ec: anchor.endCol },
        quote: anchor.quotedText,
        sha: headSha ?? '',
        thread: 'preview',
        kind: effectiveKind,
      }
    : null;
  const previewBody = meta ? embedMetadata(commentBody || '(コメント本文)', meta) : '';
  const restored = previewBody ? extractMetadata(previewBody) : null;

  const routing = anchor
    ? isRangeInDiff(diffRanges, anchor.startLine, anchor.endLine)
      ? ({ kind: 'review' } as const)
      : ({ kind: 'issue' } as const)
    : null;

  const addDraft = async () => {
    if (!anchor || !ref) return;
    const inDiff = isRangeInDiff(diffRanges, anchor.startLine, anchor.endLine);
    const path = selectedPath ?? 'sample';
    const id = crypto.randomUUID();
    const draft: PendingDraft = {
      cid: id,
      path,
      inDiff,
      range: { sl: anchor.startLine, sc: anchor.startCol, el: anchor.endLine, ec: anchor.endCol },
      quote: anchor.quotedText,
      sha: headSha ?? '',
      thread: id,
      body: commentBody.trim() || '(no comment)',
      kind: effectiveKind,
      suggestion: effectiveKind === 'suggestion' ? suggestionText : undefined,
      permalink:
        !inDiff && headSha
          ? buildBlobPermalink(ref, path, headSha, anchor.startLine, anchor.endLine)
          : undefined,
    };
    const next = [...drafts, draft];
    setDrafts(next);
    await saveDrafts(ref, next);
    setCommentBody('');
    setSuggestionText('');
    setKind('comment');
    setAnchor(null);
  };

  // スレッド返信: root の anchor を引き継ぎ、同じ thread id で draft 追加
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
      kind: 'comment',
      permalink:
        !inDiff && headSha
          ? buildBlobPermalink(ref, m.path, headSha, m.range.sl, m.range.el)
          : undefined,
    };
    const next = [...drafts, draft];
    setDrafts(next);
    await saveDrafts(ref, next);
    setReplyText('');
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
          d.kind === 'suggestion' ? `\n\n${buildSuggestionBlock(d.suggestion ?? '')}` : '';
        if (d.inDiff) {
          reviewComments.push({
            path: d.path,
            side: 'RIGHT',
            line: d.range.el,
            ...(d.range.el !== d.range.sl
              ? { start_line: d.range.sl, start_side: 'RIGHT' as const }
              : {}),
            body: embedMetadata(`${d.body}${suggestion}`, dmeta),
          });
        } else {
          const quoted = d.quote
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n');
          const note = d.kind === 'suggestion' ? '\n\n(diff 外のため提案は適用ボタンになりません)' : '';
          const visible = `${d.body}${suggestion}${note}\n\n${quoted}\n${d.permalink ?? ''}`.trimEnd();
          issueBodies.push(embedMetadata(visible, dmeta));
        }
      }
      if (reviewComments.length > 0) {
        await client.submitReview(ref, { commitId: headSha ?? undefined, comments: reviewComments });
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
        message: `docs: edit ${selectedPath} via DocReview`,
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
    setTokenInput('');
  };

  const handleClearToken = async () => {
    await clearToken();
    setToken(null);
    setFiles([]);
    setHeadSha(null);
    setSelectedPath(null);
    setSource(ref ? '' : sampleDoc);
    setBaseSource(ref ? '' : sampleDoc);
    setAnchor(null);
  };

  // 編集 → 提案変換(reviewer)。base との行差分を Suggestion ドラフト化。
  const convertEditsToSuggestions = async () => {
    if (!ref || source === baseSource) return;
    const hunks = diffToSuggestions(baseSource, source);
    if (hunks.length === 0) return;
    const path = selectedPath ?? 'sample';
    const newDrafts: PendingDraft[] = hunks.map((h) => {
      const inDiff = isRangeInDiff(diffRanges, h.sl, h.el);
      const id = crypto.randomUUID();
      return {
        cid: id,
        path,
        inDiff,
        range: { sl: h.sl, sc: 1, el: h.el, ec: 1 },
        quote: h.quote,
        sha: headSha ?? '',
        thread: id,
        body: '(編集の提案)',
        kind: 'suggestion',
        suggestion: h.replacement,
        permalink:
          !inDiff && headSha ? buildBlobPermalink(ref, path, headSha, h.sl, h.el) : undefined,
      };
    });
    const next = [...drafts, ...newDrafts];
    setDrafts(next);
    await saveDrafts(ref, next);
  };

  if (!tokenLoaded) return <p className="notice notice--muted">Loading…</p>;

  if (ref && !token) {
    return (
      <div className="gate">
        <h1>DocReview</h1>
        <p>
          {owner}/{repo} #{prNum} を開くには GitHub の fine-grained PAT が必要です。
        </p>
        <p className="notice--muted" style={{ fontSize: 13 }}>
          対象リポジトリに <code>Contents: Read and Write</code> /{' '}
          <code>Pull requests: Read and Write</code> を付与したトークンを発行してください(§7.6)。
          トークンは <code>chrome.storage.local</code> にのみ保存され、外部には送信されません(§9)。
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
          保存して開く
        </button>
      </div>
    );
  }

  const statusFor = (c: ExistingComment): AnchorStatus | null => {
    if (!c.meta || c.meta.path !== (selectedPath ?? 'sample')) return null;
    return reanchorComment(source, lineStarts, c.meta, headSha ?? '').status;
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar__brand">DocReview</span>
        {ref ? (
          <>
            <span className="topbar__meta">
              <strong>
                {owner}/{repo} #{prNum}
              </strong>
              {headSha ? <span>@ {headSha.slice(0, 7)}</span> : null}
            </span>
            {files.length > 0 ? (
              <select
                className="input"
                value={selectedPath ?? ''}
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
              <button type="button" aria-pressed={viewMode === 'preview'} className="seg--dark" onClick={() => setViewMode('preview')}>
                Preview
              </button>
              <button type="button" aria-pressed={viewMode === 'raw'} className="seg--dark" onClick={() => setViewMode('raw')}>
                Raw
              </button>
            </div>
            <div className="seg">
              <button type="button" aria-pressed={role === 'author'} onClick={() => setRole('author')}>
                author
              </button>
              <button type="button" aria-pressed={role === 'reviewer'} onClick={() => setRole('reviewer')}>
                reviewer
              </button>
            </div>
            {role === 'author' && selectedPath ? (
              <button type="button" className="btn btn--primary" onClick={commitEdit} disabled={loading}>
                Commit
              </button>
            ) : null}
            {role === 'reviewer' && source !== baseSource ? (
              <button type="button" className="btn btn--primary" onClick={convertEditsToSuggestions}>
                編集を提案に変換
              </button>
            ) : null}
            {token ? (
              <button type="button" className="btn" onClick={handleClearToken}>
                トークン削除
              </button>
            ) : null}
          </>
        ) : (
          <span className="topbar__meta">sample document (PR 指定なし)</span>
        )}
      </header>

      {loading ? <p className="notice notice--muted">読み込み中…</p> : null}
      {error ? <p className="notice notice--error">{error}</p> : null}
      {ref && !loading && !error && files.length === 0 ? (
        <p className="notice notice--muted">この PR に変更された .md ファイルがありません。</p>
      ) : null}

      <div className="layout">
        <main>
          <div className="doc">
            <CodeMirror
              ref={cmRef}
              value={source}
              extensions={cmExtensions}
              basicSetup={{ lineNumbers: viewMode === 'raw', foldGutter: viewMode === 'raw' }}
              onChange={(v) => setSource(v)}
              onUpdate={(vu) => {
                if (vu.selectionSet) {
                  const a = cmSelectionToAnchor(vu.state);
                  if (a) setAnchor(a);
                }
              }}
            />
          </div>
          <p className="doc__hint">
            本文は常に編集可能(ソースが正準)。テキストを選択して右でコメント/提案を追加できます。
          </p>
        </main>

        <aside className="sidebar">
          {/* composer (selection) */}
          {anchor ? (
            <section className="panel">
              <h2 className="panel__title">{role === 'author' ? 'Comment' : 'Comment / Suggestion'}</h2>
              {role === 'reviewer' ? (
                <div className="radio-row">
                  <label>
                    <input type="radio" name="kind" checked={kind === 'comment'} onChange={() => setKind('comment')} /> コメント
                  </label>
                  <label>
                    <input type="radio" name="kind" checked={kind === 'suggestion'} onChange={() => setKind('suggestion')} /> Suggestion
                  </label>
                </div>
              ) : null}
              {routing ? (
                <p className="composer__routing">
                  {routing.kind === 'review' ? (
                    <span className="badge badge--review">review</span>
                  ) : (
                    <span className="badge badge--issue">issue + permalink</span>
                  )}{' '}
                  <span className="notice--muted">
                    L{anchor.startLine}
                    {anchor.endLine !== anchor.startLine ? `–L${anchor.endLine}` : ''}
                  </span>
                </p>
              ) : null}
              <textarea
                className="field"
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                rows={3}
                placeholder="この選択範囲へのコメント"
              />
              {effectiveKind === 'suggestion' ? (
                <textarea
                  className="field field--mono"
                  value={suggestionText}
                  onChange={(e) => setSuggestionText(e.target.value)}
                  rows={3}
                  placeholder="置換後のソース行(対象行を丸ごと置き換えます)"
                  style={{ marginTop: 6 }}
                />
              ) : null}
              <div className="composer__row">
                <button type="button" className="btn btn--primary btn--sm" onClick={addDraft}>
                  下書きに追加
                </button>
                <button type="button" className="btn btn--sm" onClick={() => setAnchor(null)}>
                  キャンセル
                </button>
              </div>
            </section>
          ) : null}

          {/* pending drafts */}
          {ref ? (
            <section className="panel">
              <h2 className="panel__title">Pending ({drafts.length})</h2>
              {drafts.length === 0 ? (
                <p className="empty">下書きはありません。</p>
              ) : (
                <>
                  {drafts.map((d) => (
                    <div key={d.cid} className="thread">
                      <div className="comment__meta">
                        <span className={`badge badge--${d.inDiff ? 'review' : 'issue'}`}>
                          {d.inDiff ? 'review' : 'issue'}
                        </span>
                        {d.kind === 'suggestion' ? <span className="badge badge--suggestion">suggestion</span> : null}
                        <span>
                          {d.path} L{d.range.sl}
                          {d.range.el !== d.range.sl ? `–L${d.range.el}` : ''}
                        </span>
                      </div>
                      <div className="comment__body">{d.body}</div>
                      <div className="comment__actions">
                        <button type="button" className="btn btn--sm" onClick={() => removeDraft(d.cid)}>
                          削除
                        </button>
                      </div>
                    </div>
                  ))}
                  <button type="button" className="btn btn--primary" onClick={submitReview} disabled={loading} style={{ marginTop: 4 }}>
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
                <p className="empty">既存コメントはありません。</p>
              ) : (
                threads.map((t) => {
                  const st = statusFor(t.root);
                  return (
                    <div key={t.id} className="thread">
                      {t.root.meta ? (
                        <div className="thread__quote">{t.root.meta.quote}</div>
                      ) : null}
                      {t.comments.map((c, i) => (
                        <div key={`${c.source}-${c.id}`} className="comment">
                          <div className="comment__meta">
                            <span className="comment__author">@{c.author}</span>
                            <span>{c.source}</span>
                            {i === 0 && st ? <span className={`badge badge--${st}`}>{STATUS_LABEL[st]}</span> : null}
                            {i === 0 && !c.meta ? (
                              <span className="badge badge--issue">
                                {c.path ? `${c.path}:L${c.line ?? '?'}` : 'no anchor'}
                              </span>
                            ) : null}
                          </div>
                          <div className="comment__body">{c.body || '(本文なし)'}</div>
                        </div>
                      ))}
                      <div className="comment__actions">
                        {t.root.meta ? (
                          <button type="button" className="btn btn--sm" onClick={() => jumpTo(t.root)}>
                            {t.path === (selectedPath ?? 'sample') ? '本文へ' : `${t.path} を開く`}
                          </button>
                        ) : null}
                        {t.root.meta ? (
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => {
                              setReplyTo(replyTo === t.id ? null : t.id);
                              setReplyText('');
                            }}
                          >
                            返信
                          </button>
                        ) : null}
                      </div>
                      {replyTo === t.id ? (
                        <div style={{ marginTop: 8 }}>
                          <textarea
                            className="field"
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            rows={2}
                            placeholder="返信(同じスレッドに追加)"
                          />
                          <div className="composer__row">
                            <button type="button" className="btn btn--primary btn--sm" onClick={() => addReply(t.root)}>
                              下書きに追加
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

          {/* debug (collapsed by default) */}
          {anchor ? (
            <details className="panel debug">
              <summary>Debug</summary>
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
              <div style={{ marginTop: 8 }}>投稿予定の GitHub 本文:</div>
              <pre>{previewBody}</pre>
              {restored?.meta ? (
                <p style={{ color: 'var(--green)' }}>
                  ✓ ライブ往復 OK: L{restored.meta.range.sl}:{restored.meta.range.sc}–L
                  {restored.meta.range.el}:{restored.meta.range.ec}
                </p>
              ) : null}
            </details>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
