// Inject a chrome-extension-compatible `browser.storage.local` polyfill
// into the page BEFORE app code runs. The store is page-scoped (a closure
// inside the init script), so each test starts from a clean slate unless
// the caller seeds entries via the `initial` arg.
import type { Page } from "@playwright/test";

export type StorageSeed = Record<string, unknown>;

/** Install the polyfill. Call before `page.goto(...)`. */
export async function installStorage(page: Page, initial: StorageSeed = {}): Promise<void> {
  await page.addInitScript((seed) => {
    const store: Record<string, unknown> = { ...seed };
    const local = {
      get: async (
        keyOrKeys?: string | string[] | Record<string, unknown> | null,
      ): Promise<Record<string, unknown>> => {
        if (keyOrKeys === undefined || keyOrKeys === null) return { ...store };
        if (typeof keyOrKeys === "string") return { [keyOrKeys]: store[keyOrKeys] };
        if (Array.isArray(keyOrKeys)) {
          const out: Record<string, unknown> = {};
          for (const k of keyOrKeys) out[k] = store[k];
          return out;
        }
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(keyOrKeys))
          out[k] = store[k] ?? (keyOrKeys as Record<string, unknown>)[k];
        return out;
      },
      set: async (items: Record<string, unknown>): Promise<void> => {
        Object.assign(store, items);
      },
      remove: async (keyOrKeys: string | string[]): Promise<void> => {
        const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        for (const k of keys) delete store[k];
      },
      clear: async (): Promise<void> => {
        for (const k of Object.keys(store)) delete store[k];
      },
    };
    // webextension-polyfill (wxt/browser) bails with "This script should
    // only be loaded in a browser extension" unless it sees a
    // chrome.runtime.id at load time. Provide a minimal runtime + i18n
    // surface alongside the storage shim so the polyfill initialises
    // cleanly when the page bundle imports it.
    const runtime = {
      id: "e2e-mock-extension",
      // No-op event emitters keep listeners from throwing.
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
      onInstalled: { addListener: () => undefined, removeListener: () => undefined },
      sendMessage: async () => undefined,
      getManifest: () => ({ manifest_version: 3, name: "bark-e2e", version: "0.0.0" }),
      getURL: (p: string) => `/${p.replace(/^\//, "")}`,
    };
    const i18n = { getMessage: (k: string) => k };
    const apiShim = { storage: { local }, runtime, i18n };
    Object.assign(globalThis, { browser: apiShim, chrome: apiShim });
  }, initial);
}
