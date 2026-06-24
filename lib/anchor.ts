// Source anchor model and offset ↔ line/col conversion — Design Doc §7.1.
//
// `SourceAnchor` describes a selected range in the canonical source as
// `{startOffset, endOffset, line/col, quotedText}` (quotedText drives fuzzy
// re-anchoring §7.8). The helpers below convert between source offsets and
// 1-based line/col against a line index built from the source.

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
