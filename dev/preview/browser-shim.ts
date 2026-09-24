// Stands in for `wxt/browser` in the local preview. Storage is backed by
// localStorage so drafts survive a reload, like chrome.storage.local does.
type Keys = string | string[] | Record<string, unknown> | null | undefined;

const PREFIX = "bark-preview:";

function read(key: string): unknown {
  const raw = localStorage.getItem(PREFIX + key);
  return raw === null ? undefined : JSON.parse(raw);
}

async function get(keys: Keys): Promise<Record<string, unknown>> {
  if (keys === null || keys === undefined) {
    const all: Record<string, unknown> = {};
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(PREFIX)) all[k.slice(PREFIX.length)] = read(k.slice(PREFIX.length));
    }
    return all;
  }
  const defaults = typeof keys === "object" && !Array.isArray(keys) ? keys : {};
  const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  const out: Record<string, unknown> = {};
  for (const k of names) {
    const v = read(k) ?? defaults[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function set(items: Record<string, unknown>): Promise<void> {
  for (const [k, v] of Object.entries(items)) localStorage.setItem(PREFIX + k, JSON.stringify(v));
}

async function remove(keys: string | string[]): Promise<void> {
  for (const k of Array.isArray(keys) ? keys : [keys]) localStorage.removeItem(PREFIX + k);
}

export const browser = {
  storage: { local: { get, set, remove } },
  // Only the device-flow login messages the background worker; the preview
  // starts signed in, so nothing should reach this.
  runtime: { sendMessage: async () => undefined },
};
