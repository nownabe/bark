// SPA shell — Design Doc §6.
// スライス #1: GitHub から PR の変更 .md を取得して正準ソースをレンダリングし、
// 選択を SourceAnchor に解決する。v1 認証は fine-grained PAT (§7.6)。
// untrusted な実ソースは rehype-sanitize で XSS 除去する (§9)。
// コメント往復(#2)・diff 内外ルーティング(#3)は後続スライス。
import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { rehypeSourcePos, sanitizeSchema } from '../../lib/markdown';
import {
  buildLineIndex,
  rangeForOffsets,
  resolveSelection,
  type SourceAnchor,
} from '../../lib/anchor';
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
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [source, setSource] = useState<string>(ref ? '' : sampleDoc);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [anchor, setAnchor] = useState<SourceAnchor | null>(null);
  const [cid, setCid] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const [kind, setKind] = useState<'comment' | 'suggestion'>('comment');
  const [suggestionText, setSuggestionText] = useState('');
  const [comments, setComments] = useState<ExistingComment[]>([]);
  const [drafts, setDrafts] = useState<PendingDraft[]>([]);
  const docRef = useRef<HTMLDivElement>(null);

  const client = useMemo(() => (token ? new GitHubClient(token) : null), [token]);
  const lineStarts = useMemo(() => buildLineIndex(source), [source]);
  const diffRanges = useMemo(
    () => parseRightRanges(files.find((f) => f.path === selectedPath)?.patch),
    [files, selectedPath],
  );

  // 保存済みトークンの読み込み
  useEffect(() => {
    getToken().then((t) => {
      setToken(t);
      setTokenLoaded(true);
    });
  }, []);

  // PR の head SHA と変更 .md 一覧の取得
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

  // 選択ファイルの内容(正準ソース)の取得
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

  // 既存コメントの取り込み(R6)。取得失敗は本文表示を妨げないよう握りつぶす。
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
        /* ignore: コメント取得失敗は致命ではない */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ref?.owner, ref?.repo, ref?.number]);

  // ローカル下書きの読み込み(R4)。
  useEffect(() => {
    if (ref) listDrafts(ref).then(setDrafts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.owner, ref?.repo, ref?.number]);

  const jumpTo = (c: ExistingComment) => {
    if (!docRef.current || !c.meta) return;
    if (c.meta.path !== (selectedPath ?? 'sample')) {
      setSelectedPath(c.meta.path); // 別ファイル: 切替のみ(切替後の自動ハイライトは後続)
      return;
    }
    // 再アンカリング(R7): createdAtSha と head が異なれば quote で再解決。
    const r = reanchorComment(source, lineStarts, c.meta, headSha ?? '');
    if (r.status === 'outdated') return;
    const range = rangeForOffsets(docRef.current, r.startOffset, r.endOffset);
    if (!range) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    (range.startContainer.parentElement ?? docRef.current).scrollIntoView({
      block: 'center',
      behavior: 'smooth',
    });
  };

  const handleSelection = () => {
    if (!docRef.current) return;
    const resolved = resolveSelection(docRef.current, source, lineStarts);
    if (resolved) {
      setAnchor(resolved);
      setCid(crypto.randomUUID());
    }
  };

  // コンポーザ: 選択範囲 → メタデータ → 投稿予定の GitHub 本文 + ライブ往復(#2)。
  // 実投稿は #3(diff 内外ルーティング)+ 書き込みスコープのスライスで実装する。
  const meta: CommentMetadata | null = anchor
    ? {
        cid: cid || 'preview',
        path: selectedPath ?? 'sample',
        range: { sl: anchor.startLine, sc: anchor.startCol, el: anchor.endLine, ec: anchor.endCol },
        quote: anchor.quotedText,
        sha: headSha ?? '',
        thread: cid || 'preview',
      }
    : null;
  const previewBody = meta ? embedMetadata(commentBody || '(コメント本文)', meta) : '';
  const restored = previewBody ? extractMetadata(previewBody) : null;

  // diff 内/外ルーティング(#3): 選択行が全て diff 内ならレビューコメント、
  // そうでなければ通常 PR コメント(引用 + パーマリンク)。
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
    const id = cid || crypto.randomUUID();
    const draft: PendingDraft = {
      cid: id,
      path,
      inDiff,
      range: { sl: anchor.startLine, sc: anchor.startCol, el: anchor.endLine, ec: anchor.endCol },
      quote: anchor.quotedText,
      sha: headSha ?? '',
      thread: id,
      body: commentBody.trim() || '(no comment)',
      kind,
      suggestion: kind === 'suggestion' ? suggestionText : undefined,
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
        const meta: CommentMetadata = {
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
            body: embedMetadata(`${d.body}${suggestion}`, meta),
          });
        } else {
          const quoted = d.quote
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n');
          // diff 外の suggestion は「Apply」ボタンにならないため fenced block に降格(§7.3)。
          const note = d.kind === 'suggestion' ? '\n\n(diff 外のため提案は適用ボタンになりません)' : '';
          const visible = `${d.body}${suggestion}${note}\n\n${quoted}\n${d.permalink ?? ''}`.trimEnd();
          issueBodies.push(embedMetadata(visible, meta));
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

  // author 編集 → コミット(R5, §7.4)。Contents: Write 権限が必要。
  const startEdit = () => {
    setEditText(source);
    setEditing(true);
    setAnchor(null);
  };

  const commitEdit = async () => {
    if (!client || !ref || !selectedPath || !headRef) return;
    setLoading(true);
    setError(null);
    try {
      const blobSha = await client.getFileSha(ref, selectedPath, headRef);
      await client.putFileContent(ref, {
        path: selectedPath,
        content: editText,
        message: `docs: edit ${selectedPath} via DocReview`,
        sha: blobSha,
        branch: headRef,
      });
      // head が進むので再取得 → 既存コメントは R7 で再アンカーされる
      const { headSha: sha } = await client.getPull(ref);
      setHeadSha(sha);
      setSource(await client.getFileContent(ref, selectedPath, sha));
      setEditing(false);
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

  // PR を指定して開いたがトークン未設定 → 入力フォーム
  if (ref && !token) {
    return wrap(
      <div style={{ maxWidth: 560 }}>
        <h1 style={{ fontSize: 20 }}>DocReview</h1>
        <p>
          {owner}/{repo} #{prNum} を開くには GitHub の fine-grained PAT が必要です。
        </p>
        <p style={{ color: '#57606a', fontSize: 13 }}>
          対象リポジトリに <code>Contents: Read</code> / <code>Pull requests: Read</code>{' '}
          を付与したトークンを発行してください(§7.6)。トークンは{' '}
          <code>chrome.storage.local</code> にのみ保存され、外部には送信されません(§9)。
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
            {selectedPath ? (
              <button
                type="button"
                onClick={() => (editing ? setEditing(false) : startEdit())}
                style={{ marginLeft: 'auto', fontSize: 12, background: 'none', border: '1px solid #d0d7de', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}
              >
                {editing ? '閲覧に戻る' : '編集'}
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
        <main
          ref={docRef}
          onMouseUp={editing ? undefined : handleSelection}
          style={{ lineHeight: 1.7, fontSize: 16 }}
        >
          {editing ? (
            <div>
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                style={{ width: '100%', minHeight: '60vh', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 14, padding: 8, lineHeight: 1.6 }}
              />
              <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={commitEdit}
                  disabled={loading}
                  style={{ fontSize: 13, background: '#1f883d', color: '#fff', border: 0, borderRadius: 6, padding: '6px 12px', cursor: 'pointer', opacity: loading ? 0.6 : 1 }}
                >
                  Commit
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  style={{ fontSize: 13, background: 'none', border: '1px solid #d0d7de', borderRadius: 6, padding: '6px 12px', cursor: 'pointer' }}
                >
                  キャンセル
                </button>
                <span style={{ fontSize: 11, color: '#57606a' }}>
                  ソースを編集 → head ブランチにコミット(Contents: Write が必要)
                </span>
              </div>
            </div>
          ) : source ? (
            <Markdown rehypePlugins={[rehypeSourcePos, [rehypeSanitize, sanitizeSchema]]}>
              {source}
            </Markdown>
          ) : null}
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

          <h2 style={{ fontSize: 14, margin: '0 0 12px' }}>Selection anchor</h2>
          {anchor ? (
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', margin: 0 }}>
              <dt style={{ color: '#57606a' }}>offset</dt>
              <dd style={{ margin: 0 }}>
                {anchor.startOffset}–{anchor.endOffset}
              </dd>
              <dt style={{ color: '#57606a' }}>start</dt>
              <dd style={{ margin: 0 }}>
                L{anchor.startLine}:{anchor.startCol}
              </dd>
              <dt style={{ color: '#57606a' }}>end</dt>
              <dd style={{ margin: 0 }}>
                L{anchor.endLine}:{anchor.endCol}
              </dd>
              <dt style={{ color: '#57606a' }}>quoted</dt>
              <dd style={{ margin: 0 }}>
                <pre style={{ whiteSpace: 'pre-wrap', background: '#f6f8fa', padding: 8, borderRadius: 6, margin: 0, fontSize: 12 }}>
                  {anchor.quotedText}
                </pre>
              </dd>
            </dl>
          ) : (
            <p style={{ color: '#57606a', margin: 0 }}>本文中のテキストをドラッグ選択してください。</p>
          )}

          {anchor ? (
            <div style={{ marginTop: 16, borderTop: '1px solid #d0d7de', paddingTop: 12 }}>
              <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>Comment (composer)</h3>
              <div style={{ marginBottom: 8, fontSize: 12 }}>
                <label style={{ marginRight: 12 }}>
                  <input
                    type="radio"
                    name="kind"
                    checked={kind === 'comment'}
                    onChange={() => setKind('comment')}
                  />{' '}
                  コメント
                </label>
                <label>
                  <input
                    type="radio"
                    name="kind"
                    checked={kind === 'suggestion'}
                    onChange={() => setKind('suggestion')}
                  />{' '}
                  Suggestion
                </label>
              </div>
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
                      {routing.permalink ? (
                        <a
                          href={routing.permalink}
                          target="_blank"
                          rel="noreferrer"
                          style={{ display: 'block', wordBreak: 'break-all', marginTop: 4 }}
                        >
                          {routing.permalink}
                        </a>
                      ) : null}
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
              {kind === 'suggestion' ? (
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
                <summary style={{ cursor: 'pointer', color: '#57606a' }}>
                  投稿予定の GitHub 本文(メタデータ埋め込み)
                </summary>
                <pre style={{ whiteSpace: 'pre-wrap', background: '#f6f8fa', padding: 8, borderRadius: 6, fontSize: 11, marginTop: 6 }}>
                  {previewBody}
                </pre>
              </details>
              {restored?.meta ? (
                <p style={{ color: '#1a7f37', fontSize: 12, margin: '8px 0 0' }}>
                  ✓ ライブ往復 OK: アンカー復元 L{restored.meta.range.sl}:{restored.meta.range.sc}–L
                  {restored.meta.range.el}:{restored.meta.range.ec}
                </p>
              ) : null}
              <p style={{ color: '#57606a', fontSize: 11, margin: '8px 0 0' }}>
                ※ 実際の GitHub 投稿は次スライス(#3 + 書き込みスコープ)で実装。
              </p>
            </div>
          ) : null}
        </aside>
      </div>
    </>,
  );
}
