// SPA shell — Design Doc §6.
// 難所#1 スライス: サンプル Markdown をレンダリングし、選択範囲を SourceAnchor
// に解決して右パネルに表示する(レンダリング→ソース位置マッピングの検証)。
// GitHub 取得・コメント往復(#2/#3)は後続スライス。
import { useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { rehypeSourcePos } from '../../lib/markdown';
import { buildLineIndex, resolveSelection, type SourceAnchor } from '../../lib/anchor';
import { sampleDoc } from './sample';

export function App() {
  const params = new URLSearchParams(window.location.search);
  const owner = params.get('owner');
  const repo = params.get('repo');
  const pr = params.get('pr');

  // TODO(next slice): GitHub から対象 .md のソースを取得して差し替える。
  const source = sampleDoc;
  const lineStarts = useMemo(() => buildLineIndex(source), [source]);
  const docRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<SourceAnchor | null>(null);

  const handleSelection = () => {
    if (!docRef.current) return;
    const resolved = resolveSelection(docRef.current, source, lineStarts);
    if (resolved) setAnchor(resolved);
  };

  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        display: 'grid',
        gridTemplateColumns: '1fr 340px',
        gap: 24,
        maxWidth: 1100,
        margin: '0 auto',
        padding: '24px 16px',
        alignItems: 'start',
      }}
    >
      <main
        ref={docRef}
        onMouseUp={handleSelection}
        style={{ lineHeight: 1.7, fontSize: 16 }}
      >
        <header style={{ color: '#57606a', fontSize: 13, marginBottom: 16 }}>
          {owner && repo && pr ? (
            <span>
              {owner}/{repo} #{pr} ·{' '}
            </span>
          ) : null}
          <span>sample document (難所#1 verification)</span>
        </header>
        <Markdown rehypePlugins={[rehypeSourcePos]}>{source}</Markdown>
      </main>

      <aside
        style={{
          position: 'sticky',
          top: 24,
          border: '1px solid #d0d7de',
          borderRadius: 8,
          padding: 16,
          fontSize: 13,
        }}
      >
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
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  background: '#f6f8fa',
                  padding: 8,
                  borderRadius: 6,
                  margin: 0,
                  fontSize: 12,
                }}
              >
                {anchor.quotedText}
              </pre>
            </dd>
          </dl>
        ) : (
          <p style={{ color: '#57606a', margin: 0 }}>
            本文中のテキストをドラッグ選択してください。
          </p>
        )}
      </aside>
    </div>
  );
}
