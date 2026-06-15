// Selection → source anchor resolution — Design Doc §7.1.
//
// Resolve a DOM selection (Range) to `{startOffset, endOffset, line/col, quotedText}`
// in the source, using the data-so/data-eo that rehypeSourcePos baked in.
// quotedText is sliced from the canonical source (§D9) (for fuzzy matching in re-anchoring §7.8).

export interface SourceAnchor {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  quotedText: string;
}

/** Array of each line's start offset (0-based offset; used to convert to 1-based line). */
export function buildLineIndex(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** offset → 1-based {line, col}. lineStarts is the return value of buildLineIndex. */
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

/** line/col (1-based) → source offset. lineStarts is the return value of buildLineIndex. */
export function lineColToOffset(line: number, col: number, lineStarts: number[]): number {
  const base = lineStarts[Math.min(line - 1, lineStarts.length - 1)] ?? 0;
  return base + (col - 1);
}

/** source offset → DOM {node, offset} (for anchor restore / highlighting, §R6). */
export function domPointForOffset(
  root: HTMLElement,
  offset: number,
): { node: Node; offset: number } | null {
  const spans = root.querySelectorAll<HTMLElement>("span[data-so]");
  for (const span of spans) {
    const so = Number(span.dataset.so);
    const eo = Number(span.dataset.eo);
    if (offset >= so && offset <= eo) {
      const textNode = span.firstChild;
      if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        if (span.dataset.drLin === "1") {
          const len = textNode.textContent?.length ?? 0;
          return { node: textNode, offset: Math.min(offset - so, len) };
        }
        return { node: textNode, offset: 0 }; // Clamp non-linear tokens to the start
      }
    }
  }
  return null;
}

/** Build a DOM Range from the [start, end] source offsets (null if not found). */
export function rangeForOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const s = domPointForOffset(root, start);
  const e = domPointForOffset(root, end);
  if (!s || !e) return null;
  const range = document.createRange();
  try {
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
  } catch {
    return null;
  }
  return range;
}

/** Offset of the nearest ancestor element that has data-so (block-level fallback). */
function ancestorOffset(start: Element | null, root: HTMLElement): number | null {
  let el: Element | null = start;
  while (el && el !== root.parentElement) {
    if (el instanceof HTMLElement && el.dataset.so != null) return Number(el.dataset.so);
    el = el.parentElement;
  }
  return null;
}

/**
 * Convert a Range endpoint (container, offset) to a source offset.
 * @param isEnd Whether this endpoint is the end side of the selection (used for the clamp direction of non-linear tokens)
 */
function endpointToOffset(
  container: Node,
  offset: number,
  root: HTMLElement,
  isEnd: boolean,
): number | null {
  // Text node: char-level resolution via the wrapping span's data-so + in-text offset
  if (container.nodeType === Node.TEXT_NODE) {
    const parent = container.parentElement;
    const so = parent?.getAttribute("data-so");
    if (so != null) {
      // Char-level only for linear tokens. Non-linear (inline code, etc.) clamps to a boundary.
      if (parent?.getAttribute("data-dr-lin") === "1") return Number(so) + offset;
      const eo = parent?.getAttribute("data-eo");
      return isEnd && eo != null ? Number(eo) : Number(so);
    }
    return ancestorOffset(parent, root);
  }
  // Element node: offset is the child node index. Use the boundary child's data-so if present
  const el = container as HTMLElement;
  const child = el.childNodes[Math.min(offset, el.childNodes.length - 1)];
  if (child instanceof HTMLElement && child.dataset.so != null) return Number(child.dataset.so);
  return ancestorOffset(el, root);
}

/**
 * Resolve the current selection to a SourceAnchor. Returns null if there is no selection / it's out of range / it can't be resolved.
 * @param root Root element of the rendered body
 * @param source Canonical source Markdown
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
