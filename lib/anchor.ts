// Selection → source anchor resolution — Design Doc §7.1.
//
// DOM の選択(Range)を、rehypeSourcePos が焼き込んだ data-so/data-eo を頼りに
// ソース上の `{startOffset, endOffset, line/col, quotedText}` へ解決する。
// quotedText は正準ソース(§D9)から切り出す(再アンカリング §7.8 のファジーマッチ用)。

export interface SourceAnchor {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  quotedText: string;
}

/** 各行の開始 offset 配列(0-based offset, 1-based line を返す変換に使う)。 */
export function buildLineIndex(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** offset → 1-based の {line, col}。lineStarts は buildLineIndex の戻り値。 */
export function offsetToLineCol(
  offset: number,
  lineStarts: number[],
): { line: number; col: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { line: ans + 1, col: offset - lineStarts[ans] + 1 };
}

/** 直近の data-so 持ち祖先要素の offset(ブロック単位フォールバック)。 */
function ancestorOffset(start: Element | null, root: HTMLElement): number | null {
  let el: Element | null = start;
  while (el && el !== root.parentElement) {
    if (el instanceof HTMLElement && el.dataset.so != null) return Number(el.dataset.so);
    el = el.parentElement;
  }
  return null;
}

/**
 * Range の端点(container, offset)をソース offset に変換。
 * @param isEnd この端点が選択範囲の終端側か(非線形トークンのクランプ方向に使う)
 */
function endpointToOffset(
  container: Node,
  offset: number,
  root: HTMLElement,
  isEnd: boolean,
): number | null {
  // テキストノード: ラップ span の data-so + テキスト内 offset で文字単位解決
  if (container.nodeType === Node.TEXT_NODE) {
    const parent = container.parentElement;
    const so = parent?.getAttribute('data-so');
    if (so != null) {
      // 線形トークンのみ文字単位。非線形(inline code 等)は境界にクランプ。
      if (parent?.getAttribute('data-dr-lin') === '1') return Number(so) + offset;
      const eo = parent?.getAttribute('data-eo');
      return isEnd && eo != null ? Number(eo) : Number(so);
    }
    return ancestorOffset(parent, root);
  }
  // 要素ノード: offset は子ノードのインデックス。境界の子に data-so があれば使う
  const el = container as HTMLElement;
  const child = el.childNodes[Math.min(offset, el.childNodes.length - 1)];
  if (child instanceof HTMLElement && child.dataset.so != null) return Number(child.dataset.so);
  return ancestorOffset(el, root);
}

/**
 * 現在の選択範囲を SourceAnchor に解決。選択が無い/範囲外/解決不能なら null。
 * @param root レンダリング本文のルート要素
 * @param source 正準ソース Markdown
 * @param lineStarts buildLineIndex(source)
 */
export function resolveSelection(
  root: HTMLElement,
  source: string,
  lineStarts: number[],
): SourceAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  let startOffset = endpointToOffset(range.startContainer, range.startOffset, root, false);
  let endOffset = endpointToOffset(range.endContainer, range.endOffset, root, true);
  if (startOffset == null || endOffset == null) return null;
  if (startOffset > endOffset) [startOffset, endOffset] = [endOffset, startOffset];

  const quotedText = source.slice(startOffset, endOffset);
  const s = offsetToLineCol(startOffset, lineStarts);
  const e = offsetToLineCol(endOffset, lineStarts);
  return {
    startOffset,
    endOffset,
    startLine: s.line,
    startCol: s.col,
    endLine: e.line,
    endCol: e.col,
    quotedText,
  };
}
