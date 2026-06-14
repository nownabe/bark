// Local storage layer — Design Doc §7.7 / §9.
//  - chrome.storage.local: token, settings, lightweight metadata
//  - IndexedDB: per-PR pending comments/suggestions, snapshots (後続スライス)
import { browser } from 'wxt/browser';

const TOKEN_KEY = 'github_token';

/** IndexedDB / storage キー設計 (§7.7): pr:{owner}/{repo}#{number} 配下に下書き群。 */
export const storageKeys = {
  pr: (owner: string, repo: string, number: number | string) =>
    `pr:${owner}/${repo}#${number}`,
};

/** 保存済み fine-grained PAT を取得(未設定なら null)。 */
export async function getToken(): Promise<string | null> {
  const result = await browser.storage.local.get(TOKEN_KEY);
  const token = result[TOKEN_KEY];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/** PAT を保存 (§9: ローカルのみ。外部送信しない)。 */
export async function setToken(token: string): Promise<void> {
  await browser.storage.local.set({ [TOKEN_KEY]: token });
}

/** PAT を削除 (§9: 削除導線)。 */
export async function clearToken(): Promise<void> {
  await browser.storage.local.remove(TOKEN_KEY);
}
