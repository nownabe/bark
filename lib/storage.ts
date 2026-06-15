// Local storage layer — Design Doc §7.7 / §9.
//  - chrome.storage.local: token, settings, lightweight metadata
//  - IndexedDB: per-PR pending comments/suggestions, snapshots (later slice)
import { browser } from 'wxt/browser';

const TOKEN_KEY = 'github_token';

/** IndexedDB / storage key design (§7.7): drafts live under pr:{owner}/{repo}#{number}. */
export const storageKeys = {
  pr: (owner: string, repo: string, number: number | string) =>
    `pr:${owner}/${repo}#${number}`,
};

/** Get the stored fine-grained PAT (null if unset). */
export async function getToken(): Promise<string | null> {
  const result = await browser.storage.local.get(TOKEN_KEY);
  const token = result[TOKEN_KEY];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/** Save the PAT (§9: local only; never sent externally). */
export async function setToken(token: string): Promise<void> {
  await browser.storage.local.set({ [TOKEN_KEY]: token });
}

/** Delete the PAT (§9: deletion path). */
export async function clearToken(): Promise<void> {
  await browser.storage.local.remove(TOKEN_KEY);
}
