// reviewer 編集 → Suggestion 変換 + tracked-changes 用の差分(R3/§7.3, Google Docs サジェスト相当)。
//  - charDiffs: 文字単位差分(インライン装飾: 追加=下線 / 削除=取り消し線ウィジェット用)
//  - diffToSuggestions: 行単位 LCS でハンクに分け、GitHub Suggestion(行置換)に変換
import { diff_match_patch } from 'diff-match-patch';

/** コメント本文から ```suggestion ブロックの置換テキストを取り出す(無ければ null)。 */
export function extractSuggestionBlock(body: string): string | null {
  const m = body.match(/```suggestion\n?([\s\S]*?)```/);
  return m ? m[1].replace(/\n$/, '') : null;
}

/** コメント本文から suggestion ブロックを除いた可視テキスト。 */
export function stripSuggestionBlock(body: string): string {
  return body.replace(/```suggestion\n?[\s\S]*?```/g, '').trim();
}

/** 文字単位差分 [op(-1 del / 0 eq / 1 ins), text]。インライン tracked-changes 装飾用。 */
export function charDiffs(base: string, edited: string): Array<[number, string]> {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(base, edited);
  dmp.diff_cleanupSemantic(diffs);
  return diffs as Array<[number, string]>;
}

export interface SuggestionHunk {
  /** 置換対象の base 行範囲(1-based, 両端含む)。 */
  sl: number;
  el: number;
  /** 置換後テキスト(空文字 = 行削除)。 */
  replacement: string;
  /** 削除された元テキスト(アンカー quote 用)。 */
  quote: string;
}

function splitLines(s: string): string[] {
  return s.endsWith('\n') ? s.slice(0, -1).split('\n') : s.split('\n');
}

type LineOp = { op: -1 | 0 | 1; text: string };

function lcsDiff(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 0, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: -1, text: a[i] });
      i++;
    } else {
      ops.push({ op: 1, text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ op: -1, text: a[i++] });
  while (j < m) ops.push({ op: 1, text: b[j++] });
  return ops;
}

/**
 * base → edited の差分を、行を置換する GitHub Suggestion ハンクに変換する。
 * v1 は「削除 or 置換」ハンクのみ(純粋な行挿入は対象行が無いため対象外)。
 */
export function diffToSuggestions(base: string, edited: string): SuggestionHunk[] {
  const ops = lcsDiff(splitLines(base), splitLines(edited));
  const hunks: SuggestionHunk[] = [];
  let baseLine = 1;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === 0) {
      baseLine++;
      i++;
      continue;
    }
    const startLine = baseLine;
    const del: string[] = [];
    const ins: string[] = [];
    while (i < ops.length && ops[i].op !== 0) {
      if (ops[i].op === -1) {
        del.push(ops[i].text);
        baseLine++;
      } else {
        ins.push(ops[i].text);
      }
      i++;
    }
    if (del.length > 0) {
      hunks.push({
        sl: startLine,
        el: startLine + del.length - 1,
        replacement: ins.join('\n'),
        quote: del.join('\n'),
      });
    }
    // 純挿入(del.length===0)は対象行が無いため v1 では非対応
  }
  return hunks;
}
