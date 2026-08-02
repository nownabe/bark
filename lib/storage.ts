// Local storage layer.
//  - chrome.storage.local: token, settings, lightweight metadata
//  - IndexedDB: per-PR pending comments/suggestions, snapshots (later slice)
import { browser } from "wxt/browser";

const TOKEN_KEY = "github_token";
const AUTH_METHOD_KEY = "auth_method";

/** Storage key design: drafts live under pr:{owner}/{repo}#{number}. */
export const storageKeys = {
  pr: (owner: string, repo: string, number: number | string) => `pr:${owner}/${repo}#${number}`,
};

/** Get the stored bearer token (GitHub App device-flow token; null if unset). */
export async function getToken(): Promise<string | null> {
  const result = await browser.storage.local.get(TOKEN_KEY);
  const token = result[TOKEN_KEY];
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** Save the token (local only; never sent externally). */
export async function setToken(token: string): Promise<void> {
  await browser.storage.local.set({ [TOKEN_KEY]: token });
}

/** Delete the token and auth-method marker. */
export async function clearToken(): Promise<void> {
  await browser.storage.local.remove([TOKEN_KEY, AUTH_METHOD_KEY]);
}

/** Which method produced the stored token, so failure UIs can adapt. */
export type AuthMethod = "app" | "pat";

/** Get the stored auth method (null if unset or unrecognized). */
export async function getAuthMethod(): Promise<AuthMethod | null> {
  const result = await browser.storage.local.get(AUTH_METHOD_KEY);
  const method = result[AUTH_METHOD_KEY];
  return method === "app" || method === "pat" ? method : null;
}

/** Record which method produced the current token. */
export async function setAuthMethod(method: AuthMethod): Promise<void> {
  await browser.storage.local.set({ [AUTH_METHOD_KEY]: method });
}
