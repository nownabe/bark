// ローカル下書き(pending)— Design Doc §7.2 / §7.7 / R4.
// コメントを「pending」としてローカルに溜め、Submit で GitHub に一括反映する。
// v1 は軽量データなので chrome.storage.local に保持(IndexedDB はスナップショット等
// 大きいデータを扱う後続スライスで導入)。キーは pr:{owner}/{repo}#{n}:drafts。
import { browser } from 'wxt/browser';
import { storageKeys } from './storage';
import type { AnchorRange } from './metadata';
import type { PrRef } from './github';

export interface PendingDraft {
  cid: string;
  path: string;
  /** 全行 diff 内か(true=レビューコメント / false=通常コメント, §7.1)。 */
  inDiff: boolean;
  range: AnchorRange;
  quote: string;
  /** createdAtSha (§7.9)。 */
  sha: string;
  thread: string;
  /** 可視本文。 */
  body: string;
  /** diff 外コメント用の blob パーマリンク。 */
  permalink?: string;
}

function draftsKey(ref: PrRef): string {
  return `${storageKeys.pr(ref.owner, ref.repo, ref.number)}:drafts`;
}

export async function listDrafts(ref: PrRef): Promise<PendingDraft[]> {
  const key = draftsKey(ref);
  const result = await browser.storage.local.get(key);
  return (result[key] as PendingDraft[] | undefined) ?? [];
}

export async function saveDrafts(ref: PrRef, drafts: PendingDraft[]): Promise<void> {
  await browser.storage.local.set({ [draftsKey(ref)]: drafts });
}
