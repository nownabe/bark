// SPA shell — Design Doc §6.
// ドキュメント面は CodeMirror 6 に一本化(常時編集可、ソースが正準 §13)。
// Obsidian の Source ⇄ Live Preview を意識した構成で、選択は CM の offset から
// 直接 SourceAnchor 化する(旧 react-markdown DOM 逆引きは退役)。
// 役割トグル: author=編集→Commit & コメント / reviewer=Suggestion & コメント。
import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { GFM } from '@lezer/markdown';
import { EditorView } from '@codemirror/view';
import { cmSelectionToAnchor } from './cmAnchor';
import { commentHighlightField, commentHighlightTheme, setCommentHighlights } from './highlight';
import { richMarkdown, richMarkdownTheme } from './richMarkdown';
import { buildLineIndex, type SourceAnchor } from '../../lib/anchor';
import { normalizeComments, type ExistingComment } from '../../lib/comments';
import { reanchorComment } from '../../lib/reanchor';
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
  const cmRef = useRef<ReactCodeMirrorRef>(null);

  const client = useMemo(() => (token ? new GitHubClient(token) : null), [token]);
  const lineStarts = useMemo(() => buildLineIndex(source), [source]);
  const diffRanges = useMemo(
    () => parseRightRanges(files.find((f) => f.path === selectedPath)?.patch),
    [files, selectedPath],
  );
  const cmExtensions = useMemo(() => {
    const base = [
      markdown({ extensions: [GFM], codeLanguages: languages }),
      EditorView.lineWrapping,
      commentHighlightField,
      commentHighlightTheme,
    ];
    return viewMode === 'preview' ? [...base, richMarkdown, richMarkdownTheme] : base;
  }, [viewMode]);

  // 保存済みトークンの読み込み
  useEffect(() => {
    getToken().then((t) => {
      setToken(t);
      setTokenLoaded(true);
    });
  }, []);

  // PR の head(sha + ref)と変更 .md 一覧
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

  // 選択ファイルの内容(正準ソース)
  useEffect(() => {
    if (!client || !ref || !headSha || !selectedPath) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const text = await client.getFileContent(ref, selectedPath, headSha);
        if (!cancelled) setSource(text);
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

  // 既存コメントの取り込み(R6)
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

  // ローカル下書きの読み込み(R4)
  useEffect(() => {
    if (ref) listDrafts(ref).then(setDrafts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.owner, ref?.repo, ref?.number]);

  // コメントアンカーを CM 本文にハイライト(R6)。source/コメント変化で再計算。
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
      setSelectedPath(c.meta.path); // 別ファイル: 切替のみ
      return;
    }
    const r = reanchorComment(source, lineStarts, c.meta, headSha ?? '');
    if (r.status === 'outdated') return;
    view.dispatch({ selection: { anchor: r.startOffset, head: r.endOffset }, scrollIntoView: true });
    view.focus();
  };

  // コンポーザ用メタデータ + ライブ往復(#2)
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

  // diff 内/外ルーティング(#3)
  const routing = anchor
    ? isRangeInDiff(diffRanges, anchor.startLine, anchor.endLine)
      ? ({ kind: 'review' } as const)
      : ({
          kind: 'issue',
          permalink:
            ref && headSha && selectedPath
              ? buildBlobPermalink(ref, selectedPath, headSha, anchor.startLine, anchor.endLine)
              : null,
        } as const)
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

  // author 編集 → コミット(R5, §7.4)。常時編集なので現在の source をそのままコミット。
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
      setSource(await client.getFileContent(ref, selectedPath, sha));
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
    setAnchor(null);
  };

  const wrap = (children: React.ReactNode) => (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>
      {children}
    </div>
  );

  if (!tokenLoaded) return wrap(<p>Loading…</p>);

  if (ref && !token) {
    return wrap(
      <div style={{ maxWidth: 560 }}>
        <h1 style={{ fontSize: 20 }}>DocReview</h1>
        <p>
          {owner}/{repo} #{prNum} を開くには GitHub の fine-grained PAT が必要です。
        </p>
        <p style={{ color: '#57606a', fontSize: 13 }}>
          対象リポジトリに <code>Contents: Read and Write</code> /{' '}
          <code>Pull requests: Read and Write</code> を付与したトークンを発行してください(§7.6)。
          トークンは <code>chrome.storage.local</code> にのみ保存され、外部には送信されません(§9)。
        </p>
        <input
          type="password"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="github_pat_..."
          style={{ width: '100%', padding: 8, fontSize: 14, boxSizing: 'border-box' }}
        />
        <button
          type="button"
          onClick={saveToken}
          style={{ marginTop: 12, padding: '8px 14px', background: '#1f883d', color: '#fff', border: 0, borderRadius: 6, cursor: 'pointer' }}
        >
          保存して開く
        </button>
      </div>,
    );
  }

  const roleButton = (r: Role, label: string) => (
    <button
      type="button"
      onClick={() => setRole(r)}
      style={{
        fontSize: 12,
        padding: '2px 10px',
        border: '1px solid #d0d7de',
        background: role === r ? '#0969da' : 'none',
        color: role === r ? '#fff' : '#1f2328',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  const modeButton = (m: ViewMode, label: string) => (
    <button
      type="button"
      onClick={() => setViewMode(m)}
      style={{
        fontSize: 12,
        padding: '2px 10px',
        border: '1px solid #d0d7de',
        background: viewMode === m ? '#1f2328' : 'none',
        color: viewMode === m ? '#fff' : '#1f2328',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  return wrap(
    <>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16, fontSize: 13, color: '#57606a' }}>
        {ref ? (
          <>
            <strong style={{ color: '#1f2328' }}>
              {owner}/{repo} #{prNum}
            </strong>
            {headSha ? <span>@ {headSha.slice(0, 7)}</span> : null}
            {files.length > 0 ? (
              <select
                value={selectedPath ?? ''}
                onChange={(e) => {
                  setSelectedPath(e.target.value);
                  setAnchor(null);
                }}
                style={{ fontSize: 13, padding: 4 }}
              >
                {files.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.path}
                  </option>
                ))}
              </select>
            ) : null}
            <span style={{ display: 'inline-flex', borderRadius: 6, overflow: 'hidden' }}>
              {modeButton('preview', 'Preview')}
              {modeButton('raw', 'Raw')}
            </span>
            <span style={{ display: 'inline-flex', marginLeft: 'auto', borderRadius: 6, overflow: 'hidden' }}>
              {roleButton('author', 'author')}
              {roleButton('reviewer', 'reviewer')}
            </span>
            {role === 'author' && selectedPath ? (
              <button
                type="button"
                onClick={commitEdit}
                disabled={loading}
                style={{ fontSize: 12, background: '#1f883d', color: '#fff', border: 0, borderRadius: 6, padding: '2px 10px', cursor: 'pointer', opacity: loading ? 0.6 : 1 }}
              >
                Commit
              </button>
            ) : null}
            {token ? (
              <button type="button" onClick={handleClearToken} style={{ fontSize: 12, background: 'none', border: '1px solid #d0d7de', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>
                トークン削除
              </button>
            ) : null}
          </>
        ) : (
          <span>sample document (PR 指定なしで開いています)</span>
        )}
      </header>

      {loading ? <p style={{ color: '#57606a' }}>読み込み中…</p> : null}
      {error ? <p style={{ color: '#cf222e' }}>{error}</p> : null}
      {ref && !loading && !error && files.length === 0 ? (
        <p style={{ color: '#57606a' }}>この PR に変更された .md ファイルがありません。</p>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24, alignItems: 'start' }}>
        <main style={{ minWidth: 0 }}>
          <div style={{ border: '1px solid #d0d7de', borderRadius: 6, overflow: 'hidden' }}>
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
          <p style={{ color: '#57606a', fontSize: 11, marginTop: 6 }}>
            本文は常に編集可能(ソースが正準)。テキストを選択して右でコメント/提案を追加できます。
          </p>
        </main>

        <aside style={{ position: 'sticky', top: 24, border: '1px solid #d0d7de', borderRadius: 8, padding: 16, fontSize: 13 }}>
          {ref ? (
            <div style={{ marginBottom: 16, borderBottom: '1px solid #d0d7de', paddingBottom: 12 }}>
              <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Pending ({drafts.length})</h2>
              {drafts.length === 0 ? (
                <p style={{ color: '#57606a', margin: 0 }}>下書きはありません。選択してコメントを追加してください。</p>
              ) : (
                <>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                    {drafts.map((d) => (
                      <li key={d.cid} style={{ fontSize: 12, border: '1px solid #eaeef2', borderRadius: 6, padding: 8 }}>
                        <div style={{ color: '#57606a', marginBottom: 4 }}>
                          {d.path} L{d.range.sl}
                          {d.range.el !== d.range.sl ? `–L${d.range.el}` : ''} ·{' '}
                          {d.inDiff ? 'review' : 'issue'}
                          {d.kind === 'suggestion' ? ' · suggestion' : ''}
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap' }}>{d.body}</div>
                        <button
                          type="button"
                          onClick={() => removeDraft(d.cid)}
                          style={{ marginTop: 6, fontSize: 11, border: '1px solid #d0d7de', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', background: 'none' }}
                        >
                          削除
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onClick={submitReview}
                    disabled={loading}
                    style={{ marginTop: 10, fontSize: 13, background: '#1f883d', color: '#fff', border: 0, borderRadius: 6, padding: '6px 12px', cursor: 'pointer', opacity: loading ? 0.6 : 1 }}
                  >
                    Submit review ({drafts.length})
                  </button>
                </>
              )}
            </div>
          ) : null}

          {ref ? (
            <div style={{ marginBottom: 16, borderBottom: '1px solid #d0d7de', paddingBottom: 12 }}>
              <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Comments ({comments.length})</h2>
              {comments.length === 0 ? (
                <p style={{ color: '#57606a', margin: 0 }}>既存コメントはありません。</p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                  {comments.map((c) => (
                    <li key={`${c.source}-${c.id}`} style={{ fontSize: 12, border: '1px solid #eaeef2', borderRadius: 6, padding: 8 }}>
                      <div style={{ color: '#57606a', marginBottom: 4 }}>
                        @{c.author} · {c.source}
                        {c.meta ? (
                          (() => {
                            const sameFile = c.meta.path === (selectedPath ?? 'sample');
                            const status = sameFile
                              ? reanchorComment(source, lineStarts, c.meta, headSha ?? '').status
                              : null;
                            if (status === 'reanchored')
                              return <span style={{ color: '#9a6700' }}> · 再アンカー</span>;
                            if (status === 'outdated')
                              return <span style={{ color: '#cf222e' }}> · 位置不明</span>;
                            return <span style={{ color: '#1a7f37' }}> · anchored</span>;
                          })()
                        ) : (
                          <span style={{ color: '#9a6700' }}>
                            {' '}
                            · {c.path ? `${c.path}:L${c.line ?? '?'}` : 'no anchor'}
                          </span>
                        )}
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap' }}>{c.body || '(本文なし)'}</div>
                      {c.meta ? (
                        <button
                          type="button"
                          onClick={() => jumpTo(c)}
                          style={{ marginTop: 6, fontSize: 11, border: '1px solid #d0d7de', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', background: 'none' }}
                        >
                          {c.meta.path === (selectedPath ?? 'sample') ? '本文へジャンプ' : `${c.meta.path} を開く`}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          <h2 style={{ fontSize: 14, margin: '0 0 12px' }}>Selection</h2>
          {anchor ? (
            <>
              <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', margin: 0 }}>
                <dt style={{ color: '#57606a' }}>range</dt>
                <dd style={{ margin: 0 }}>
                  L{anchor.startLine}:{anchor.startCol}–L{anchor.endLine}:{anchor.endCol}
                </dd>
                <dt style={{ color: '#57606a' }}>quoted</dt>
                <dd style={{ margin: 0 }}>
                  <pre style={{ whiteSpace: 'pre-wrap', background: '#f6f8fa', padding: 8, borderRadius: 6, margin: 0, fontSize: 12 }}>
                    {anchor.quotedText}
                  </pre>
                </dd>
              </dl>

              <div style={{ marginTop: 16, borderTop: '1px solid #d0d7de', paddingTop: 12 }}>
                <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>
                  {role === 'author' ? 'Comment' : 'Comment / Suggestion'}
                </h3>
                {role === 'reviewer' ? (
                  <div style={{ marginBottom: 8, fontSize: 12 }}>
                    <label style={{ marginRight: 12 }}>
                      <input type="radio" name="kind" checked={kind === 'comment'} onChange={() => setKind('comment')} />{' '}
                      コメント
                    </label>
                    <label>
                      <input type="radio" name="kind" checked={kind === 'suggestion'} onChange={() => setKind('suggestion')} />{' '}
                      Suggestion
                    </label>
                  </div>
                ) : null}
                {routing ? (
                  <div style={{ marginBottom: 8, fontSize: 12 }}>
                    {routing.kind === 'review' ? (
                      <span style={{ color: '#1a7f37' }}>
                        → レビューコメント(diff 内 RIGHT L{anchor.startLine}
                        {anchor.endLine !== anchor.startLine ? `–L${anchor.endLine}` : ''})
                      </span>
                    ) : (
                      <span style={{ color: '#9a6700' }}>
                        → 通常 PR コメント(diff 外 · 引用+パーマリンク)
                      </span>
                    )}
                  </div>
                ) : null}
                <textarea
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                  rows={3}
                  placeholder="この選択範囲へのコメント"
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, padding: 6 }}
                />
                {effectiveKind === 'suggestion' ? (
                  <textarea
                    value={suggestionText}
                    onChange={(e) => setSuggestionText(e.target.value)}
                    rows={3}
                    placeholder="置換後のソース行(対象行を丸ごと置き換えます)"
                    style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, padding: 6, marginTop: 6, fontFamily: 'monospace' }}
                  />
                ) : null}
                {ref ? (
                  <button
                    type="button"
                    onClick={addDraft}
                    style={{ marginTop: 8, fontSize: 12, background: '#1f883d', color: '#fff', border: 0, borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}
                  >
                    下書きに追加
                  </button>
                ) : null}
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: 'pointer', color: '#57606a' }}>投稿予定の GitHub 本文</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', background: '#f6f8fa', padding: 8, borderRadius: 6, fontSize: 11, marginTop: 6 }}>
                    {previewBody}
                  </pre>
                </details>
                {restored?.meta ? (
                  <p style={{ color: '#1a7f37', fontSize: 12, margin: '8px 0 0' }}>
                    ✓ ライブ往復 OK: L{restored.meta.range.sl}:{restored.meta.range.sc}–L
                    {restored.meta.range.el}:{restored.meta.range.ec}
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <p style={{ color: '#57606a', margin: 0 }}>本文中のテキストを選択してください。</p>
          )}
        </aside>
      </div>
    </>,
  );
}
