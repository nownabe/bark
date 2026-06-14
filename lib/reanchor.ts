// 再アンカリング — Design Doc §7.8 / R7.
//
// head が新しいコミットに進むと、コメントに保存された line/col(createdAtSha 時点)は
// 現在のソースとズレうる。createdAtSha が現在の head と一致すれば保存値をそのまま使い、
// 異なる場合は quotedText で現在ソースを照合して再解決する。見つからなければ outdated。
// v1 は quotedText の完全部分一致 + 元の位置に最も近い候補を採用(真のファジー/差分照合は後続)。
import { lineColToOffset } from './anchor';
import type { CommentMetadata } from './metadata';

export type AnchorStatus = 'current' | 'reanchored' | 'outdated';

export interface Reanchored {
  startOffset: number;
  endOffset: number;
  status: AnchorStatus;
}

/** haystack 内の needle 出現のうち hint offset に最も近いものの index(無ければ -1)。 */
function nearestIndexOf(haystack: string, needle: string, hint: number): number {
  let best = -1;
  let bestDist = Infinity;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    const dist = Math.abs(i - hint);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
    from = i + 1;
  }
  return best;
}

/**
 * コメントのアンカーを現在のソースに対して解決する。
 * @param source    現在(head)の正準ソース
 * @param lineStarts buildLineIndex(source)
 * @param meta      コメントの埋め込みメタデータ(quote / range / createdAtSha)
 * @param headSha   現在の head SHA
 */
export function reanchorComment(
  source: string,
  lineStarts: number[],
  meta: CommentMetadata,
  headSha: string,
): Reanchored {
  // createdAtSha が現在 head と一致 → 保存 line/col が正確
  if (meta.sha && meta.sha === headSha) {
    return {
      startOffset: lineColToOffset(meta.range.sl, meta.range.sc, lineStarts),
      endOffset: lineColToOffset(meta.range.el, meta.range.ec, lineStarts),
      status: 'current',
    };
  }
  const quote = meta.quote ?? '';
  if (quote.length === 0) return { startOffset: 0, endOffset: 0, status: 'outdated' };

  // 元の行を手掛かりに、現在ソースで quote を照合
  const hint = lineColToOffset(meta.range.sl, meta.range.sc, lineStarts);
  const idx = nearestIndexOf(source, quote, hint);
  if (idx < 0) return { startOffset: 0, endOffset: 0, status: 'outdated' };
  return { startOffset: idx, endOffset: idx + quote.length, status: 'reanchored' };
}
