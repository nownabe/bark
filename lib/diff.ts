// Diff 内/外ルーティング — Design Doc §7.1 / 決定 D4.
//
// GitHub のレビューコメントは diff ハンク内の行にしか付けられない。pulls/{n}/files
// が返す unified-diff の patch を解析し、RIGHT(新ファイル)側でコメント可能な行範囲を
// 求める。選択範囲が全て diff 内なら → レビューコメント、そうでなければ → 通常 PR
// コメント(引用+パーマリンク)に振り分ける。

/** RIGHT(新ファイル)側でコメント可能な行範囲(両端含む)。 */
export interface RightRange {
  newStart: number;
  newEnd: number;
}

/**
 * unified-diff の patch を、RIGHT 側でコメント可能な新ファイル行範囲の配列に変換。
 * 追加行(+)と文脈行(空白始まり)はハンク内で RIGHT に現れコメント可能。
 * 削除行(-)は LEFT のみで新ファイル行番号を進めない。
 */
export function parseRightRanges(patch: string | undefined): RightRange[] {
  if (!patch) return [];
  const ranges: RightRange[] = [];
  let newLine = 0;
  let start = -1;
  let end = -1;
  const flush = () => {
    if (start !== -1) {
      ranges.push({ newStart: start, newEnd: end });
      start = -1;
      end = -1;
    }
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      flush();
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLine = m ? Number(m[1]) : 0;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      if (start === -1) start = newLine;
      end = newLine;
      newLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // 削除行: LEFT のみ。newLine は進めず、RIGHT 側の連続性も保つ(flush しない)。
    } else if (line.startsWith(' ')) {
      if (start === -1) start = newLine;
      end = newLine;
      newLine++;
    }
    // それ以外(\ No newline, ファイルヘッダ, 空文字)は無視
  }
  flush();
  return ranges;
}

/** 行が RIGHT 側 diff 内か。 */
export function isLineInDiff(ranges: RightRange[], line: number): boolean {
  return ranges.some((r) => line >= r.newStart && line <= r.newEnd);
}

/** [startLine, endLine] の全行が diff 内なら true(= レビューコメント可能)。 */
export function isRangeInDiff(ranges: RightRange[], startLine: number, endLine: number): boolean {
  for (let l = startLine; l <= endLine; l++) {
    if (!isLineInDiff(ranges, l)) return false;
  }
  return true;
}
