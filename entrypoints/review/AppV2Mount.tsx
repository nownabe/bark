// AppV2Mount — production entry point for the V2 review surface.
//
// Responsibilities:
//  - Parse the PR ref from URL query params (?owner=&repo=&pr=).
//  - Handle GitHub authentication (device flow + PAT) via the
//    existing LoginGate component when no token is present.
//  - Call bootstrapPullRequest() once a token + PR ref are available.
//  - Render <AppV2 /> on success; surface missing-PR / bootstrap
//    errors clearly otherwise.

import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { type DeviceAuthorization, pollForToken, requestDeviceAuthorization } from "../../lib/auth";
import { bootstrapPullRequest, type BootstrappedPullRequest } from "../../lib/pr/bootstrap";
import type { PrRef } from "../../lib/pr/github-transport";
import {
  type AuthMethod,
  getAuthMethod,
  getToken,
  setAuthMethod as persistAuthMethod,
  setToken as persistToken,
} from "../../lib/storage";
import { AppV2 } from "./AppV2";
import { LoginGate } from "./components/LoginGate";

type BootState =
  | { kind: "loading" }
  | { kind: "missing-pr" }
  | { kind: "needs-auth" }
  | { kind: "bootstrapping" }
  | { kind: "error"; message: string }
  | { kind: "ready"; pr: BootstrappedPullRequest };

export function AppV2Mount() {
  const ref = useRef<PrRef | null>(null);
  if (ref.current === null) ref.current = parsePrRef();
  const prRef = ref.current;

  const [state, setState] = useState<BootState>({ kind: "loading" });
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthorization | null>(null);
  const [authStarting, setAuthStarting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [token, setTokenState] = useState<string | null>(null);

  // On mount: do we have a PR ref + token already?
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!prRef) {
        if (!cancelled) setState({ kind: "missing-pr" });
        return;
      }
      const t = await getToken();
      if (cancelled) return;
      if (!t) {
        setState({ kind: "needs-auth" });
        return;
      }
      setTokenState(t);
    })();
    return () => {
      cancelled = true;
    };
  }, [prRef]);

  // Whenever we acquire a token, bootstrap the data layer.
  useEffect(() => {
    if (!token || !prRef) return;
    let cancelled = false;
    setState({ kind: "bootstrapping" });
    void (async () => {
      try {
        const pr = await bootstrapPullRequest({
          token,
          prRef,
          storage: browser.storage.local,
        });
        if (!cancelled) setState({ kind: "ready", pr });
      } catch (e) {
        if (!cancelled) {
          setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, prRef]);

  // Device-flow polling: while a pending authorization exists, poll for
  // the token. Mirrors the legacy App.tsx loop.
  useEffect(() => {
    if (!deviceAuth) return;
    let cancelled = false;
    let delay = deviceAuth.interval * 1000;
    const deadline = Date.now() + deviceAuth.expiresIn * 1000;
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() >= deadline) {
        setAuthError("The authorization code expired. Please try again.");
        setDeviceAuth(null);
        return;
      }
      try {
        const r = await pollForToken(deviceAuth.deviceCode);
        if (cancelled) return;
        if (r.kind === "authorized") {
          await persistToken(r.token);
          await persistAuthMethod("app");
          setDeviceAuth(null);
          setAuthError(null);
          setTokenState(r.token);
          return;
        }
        if (r.kind === "slow_down") {
          delay = r.interval * 1000;
        }
      } catch (e) {
        if (cancelled) return;
        // Terminal failures (expired_token, access_denied, …) come through as
        // thrown errors. Surface the message and stop polling.
        setAuthError(e instanceof Error ? e.message : "Authorization failed.");
        setDeviceAuth(null);
        return;
      }
      setTimeout(tick, delay);
    };
    const id = setTimeout(tick, delay);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [deviceAuth]);

  const onStartDeviceFlow = async () => {
    setAuthStarting(true);
    setAuthError(null);
    try {
      const auth = await requestDeviceAuthorization();
      setDeviceAuth(auth);
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : "Could not start GitHub authorization.");
    } finally {
      setAuthStarting(false);
    }
  };

  const onAuthenticated = async (newToken: string, method: AuthMethod) => {
    await persistToken(newToken);
    await persistAuthMethod(method);
    setTokenState(newToken);
    setDeviceAuth(null);
    setAuthError(null);
    // Bridge for the legacy LoginGate's optional auth-method tracking.
    void getAuthMethod();
  };

  // ---- render ----

  if (state.kind === "loading") {
    return <BootGate>Loading…</BootGate>;
  }
  if (state.kind === "missing-pr") {
    return (
      <BootGate>
        Missing PR reference. Open the review page with
        <code> ?owner=…&repo=…&pr=…</code>.
      </BootGate>
    );
  }
  if (state.kind === "needs-auth" && prRef) {
    return (
      <LoginGate
        owner={prRef.owner}
        repo={prRef.repo}
        prNum={String(prRef.number)}
        deviceAuth={deviceAuth}
        authStarting={authStarting}
        authError={authError}
        onStartDeviceFlow={onStartDeviceFlow}
        onAuthenticated={onAuthenticated}
      />
    );
  }
  if (state.kind === "bootstrapping") {
    return <BootGate>Loading review…</BootGate>;
  }
  if (state.kind === "error") {
    return (
      <BootGate>
        <span>Could not start the review surface.</span>
        <pre className="appv2__boot-error">{state.message}</pre>
      </BootGate>
    );
  }
  if (state.kind === "ready") {
    return <AppV2 repository={state.pr.repository} refresh={state.pr.refresh} />;
  }
  return null;
}

function BootGate({ children }: { children: React.ReactNode }) {
  return (
    <main className="appv2 appv2--gate">
      <p className="appv2__loading">{children}</p>
    </main>
  );
}

function parsePrRef(): PrRef | null {
  const params = new URLSearchParams(window.location.search);
  const owner = params.get("owner");
  const repo = params.get("repo");
  const num = params.get("pr");
  if (!owner || !repo || !num) return null;
  const number = Number(num);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { owner, repo, number };
}
