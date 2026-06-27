// Authentication flow (token + device-flow polling + PAT completion).
//
// The legacy App used to inline all of this; pulling it into a hook gives
// us a single, testable surface for the lifecycle:
//
//   - tokenLoaded → initial read of the persisted token + method completed
//   - deviceAuth  → an in-progress GitHub App "device flow" grant
//   - startDeviceFlow / completeAuth / clearToken → user-triggered actions
//
// The hook takes its IO (auth + storage) as injected deps, so tests can
// swap them for fast in-memory fakes. The production wiring lives in a
// separate file (`useAuthFlow.deps.ts`) so the test import never pulls in
// `wxt/browser`, which throws outside a real extension runtime.

import { useEffect, useState } from "react";
import type { DeviceAuthorization, PollOutcome } from "../../../lib/auth";
import type { AuthMethod } from "../../../lib/storage";

export type AuthFlowDeps = {
  getToken: () => Promise<string | null>;
  getAuthMethod: () => Promise<AuthMethod | null>;
  persistToken: (token: string) => Promise<void>;
  persistAuthMethod: (method: AuthMethod) => Promise<void>;
  clearStoredToken: () => Promise<void>;
  requestDeviceAuthorization: () => Promise<DeviceAuthorization>;
  pollForToken: (deviceCode: string) => Promise<PollOutcome>;
};

export type AuthFlow = {
  token: string | null;
  authMethod: AuthMethod | null;
  tokenLoaded: boolean;
  deviceAuth: DeviceAuthorization | null;
  authStarting: boolean;
  authError: string | null;
  /** Kick off the GitHub App "device flow": request a user code, then poll. */
  startDeviceFlow: () => Promise<void>;
  /** Finish a PAT (or non-device) authentication: persist + apply. */
  completeAuth: (token: string, method: AuthMethod) => Promise<void>;
  /** Drop the stored token + reset every auth field. UI-side cleanup
   *  (clearing fetched files, source, etc.) is the parent's job. */
  clearToken: () => Promise<void>;
};

export function useAuthFlow(deps: AuthFlowDeps): AuthFlow {
  const [token, setToken] = useState<string | null>(null);
  const [authMethod, setAuthMethod] = useState<AuthMethod | null>(null);
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthorization | null>(null);
  const [authStarting, setAuthStarting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Initial restore: read whatever was persisted, then mark loaded so the
  // UI can pick a gate (login / install / app).
  useEffect(() => {
    let cancelled = false;
    Promise.all([deps.getToken(), deps.getAuthMethod()]).then(([t, m]) => {
      if (cancelled) return;
      setToken(t);
      setAuthMethod(m);
      setTokenLoaded(true);
    });
    return () => {
      cancelled = true;
    };
    // deps stay stable across renders for production callers; tests recreate
    // the hook before tweaking. Intentionally empty so we don't re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Device-flow polling (§7.6): once a grant exists, poll GitHub at its
  // interval until authorization succeeds, the code expires, or we hit an
  // error. A self-scheduling timeout lets us honor `slow_down` widening.
  useEffect(() => {
    if (!deviceAuth) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let delay = deviceAuth.interval * 1000;
    const deadline = Date.now() + deviceAuth.expiresIn * 1000;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() > deadline) {
        setAuthError("The code expired before you authorized. Please try again.");
        setDeviceAuth(null);
        return;
      }
      try {
        const r = await deps.pollForToken(deviceAuth.deviceCode);
        if (cancelled) return;
        if (r.kind === "authorized") {
          await deps.persistToken(r.token);
          await deps.persistAuthMethod("app");
          setToken(r.token);
          setAuthMethod("app");
          setDeviceAuth(null);
          return;
        }
        if (r.kind === "slow_down") delay = r.interval * 1000;
      } catch (e) {
        if (cancelled) return;
        setAuthError(e instanceof Error ? e.message : String(e));
        setDeviceAuth(null);
        return;
      }
      timer = setTimeout(tick, delay);
    };

    timer = setTimeout(tick, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // deps is intentionally not in the dep array — it would re-arm the poll
    // every render. Tests that swap deps remount the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceAuth]);

  const startDeviceFlow = async () => {
    setAuthError(null);
    setAuthStarting(true);
    try {
      setDeviceAuth(await deps.requestDeviceAuthorization());
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuthStarting(false);
    }
  };

  const completeAuth = async (newToken: string, method: AuthMethod) => {
    await deps.persistToken(newToken);
    await deps.persistAuthMethod(method);
    setToken(newToken);
    setAuthMethod(method);
  };

  const clearToken = async () => {
    await deps.clearStoredToken();
    setToken(null);
    setAuthMethod(null);
    setDeviceAuth(null);
    setAuthError(null);
  };

  return {
    token,
    authMethod,
    tokenLoaded,
    deviceAuth,
    authStarting,
    authError,
    startDeviceFlow,
    completeAuth,
    clearToken,
  };
}
