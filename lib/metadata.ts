// 埋め込みメタデータのコーデック — Design Doc §7.1 / 決定 D5.
//
// レビューコメント本文の末尾に「ツールだけが読む」不可視マーカー(HTML コメント)を
// 付け、ツールが文字単位アンカー・スレッド・状態を完全再現できるようにする。
// GitHub 上では HTML コメントなので非表示、ツール未導入でも壊れない。
//
// 設計からの改良: HTML コメントは仕様上 `--` を含められないため、quotedText に
// `--`(例: `---`)が入ると生 JSON 埋め込みは壊れる。そこで JSON を UTF-8 安全な
// base64 にしてから埋め込む(日本語 quote も安全)。

/** ソース上の範囲(start/end の line・col)。§7.1 の range。 */
export interface AnchorRange {
  sl: number;
  sc: number;
  el: number;
  ec: number;
}

/** コメント本文に埋め込む構造化メタデータ(§7.1)。 */
export interface CommentMetadata {
  /** comment id(ローカル uuid)。 */
  cid: string;
  path: string;
  range: AnchorRange;
  /** 再アンカリング(§7.8)用の引用テキスト。 */
  quote: string;
  /** どの時点のソースに対する指摘か(createdAtSha, §7.9)。 */
  sha: string;
  /** 会話のまとまり(threadId, §7.1)。 */
  thread: string;
}

const MARKER_RE = /\n*<!--\s*docreview:v1\s+([A-Za-z0-9+/=]+)\s*-->\s*$/;

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 可視本文の末尾に不可視メタデータマーカーを付けて返す。 */
export function embedMetadata(visibleBody: string, meta: CommentMetadata): string {
  const payload = toBase64(JSON.stringify(meta));
  return `${visibleBody.trimEnd()}\n\n<!-- docreview:v1 ${payload} -->`;
}

/**
 * コメント本文からメタデータを抽出し、可視本文と分離する。
 * マーカーが無い/壊れている場合は meta=null(行アンカーへ degrade, §12-8)。
 */
export function extractMetadata(body: string): { body: string; meta: CommentMetadata | null } {
  const m = body.match(MARKER_RE);
  if (!m || m.index == null) return { body, meta: null };
  try {
    const meta = JSON.parse(fromBase64(m[1])) as CommentMetadata;
    return { body: body.slice(0, m.index).trimEnd(), meta };
  } catch {
    return { body, meta: null };
  }
}
