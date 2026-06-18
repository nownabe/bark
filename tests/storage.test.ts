import { beforeEach, describe, expect, mock, test } from "bun:test";

// In-memory stand-in for chrome.storage.local.
let store: Record<string, unknown> = {};
mock.module("wxt/browser", () => ({
  browser: {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        },
        remove: async (key: string | string[]) => {
          for (const k of Array.isArray(key) ? key : [key]) delete store[k];
        },
      },
    },
  },
}));

const { getToken, setToken, clearToken, getAuthMethod, setAuthMethod } =
  await import("../lib/storage");

beforeEach(() => {
  store = {};
});

describe("auth method", () => {
  test("round-trips pat and app", async () => {
    await setAuthMethod("pat");
    expect(await getAuthMethod()).toBe("pat");
    await setAuthMethod("app");
    expect(await getAuthMethod()).toBe("app");
  });

  test("returns null when unset", async () => {
    expect(await getAuthMethod()).toBeNull();
  });

  test("returns null for an unrecognized stored value", async () => {
    store["auth_method"] = "bogus";
    expect(await getAuthMethod()).toBeNull();
  });

  test("clearToken removes both the token and the auth method", async () => {
    await setToken("ghp_token");
    await setAuthMethod("pat");
    await clearToken();
    expect(await getToken()).toBeNull();
    expect(await getAuthMethod()).toBeNull();
  });
});
