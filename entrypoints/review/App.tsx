// SPA shell — Design Doc §6.
// スライス #1: GitHub から PR の変更 .md を取得して正準ソースをレンダリングし、
// 選択を SourceAnchor に解決する。v1 認証は fine-grained PAT (§7.6)。
// untrusted な実ソースは rehype-sanitize で XSS 除去する (§9)。
// コメント往復(#2)・diff 内外ルーティング(#3)は後続スライス。
import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { rehypeSourcePos, sanitizeSchema } from '../../lib/markdown';
import { buildLineIndex, resolveSelection, type SourceAnchor } from '../../lib/anchor';
import {
  GitHubApiError,
  GitHubClient,
  type ChangedFile,
  type PrRef,
} from '../../lib/github';
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [source, setSource] = useState<string>(ref ? '' : sampleDoc);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [anchor, setAnchor] = useState<SourceAnchor | null>(null);
  const [cid, setCid] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const docRef = useRef<HTMLDivElement>(null);

  const client = useMemo(() => (token ? new GitHubClient(token) : null), [token]);
  const lineStarts = useMemo(() => buildLineIndex(source), [source]);

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
        const sha = await client.getPullHeadSha(ref);
        const md = await client.listMarkdownFiles(ref);
        if (cancelled) return;
        setHeadSha(sha);
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
            {token ? (
              <button type="button" onClick={handleClearToken} style={{ marginLeft: 'auto', fontSize: 12, background: 'none', border: '1px solid #d0d7de', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>
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
        <main ref={docRef} onMouseUp={handleSelection} style={{ lineHeight: 1.7, fontSize: 16 }}>
          {source ? (
            <Markdown rehypePlugins={[rehypeSourcePos, [rehypeSanitize, sanitizeSchema]]}>
              {source}
            </Markdown>
          ) : null}
        </main>

        <aside style={{ position: 'sticky', top: 24, border: '1px solid #d0d7de', borderRadius: 8, padding: 16, fontSize: 13 }}>
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
              <textarea
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                rows={3}
                placeholder="この選択範囲へのコメント"
                style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, padding: 6 }}
              />
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
