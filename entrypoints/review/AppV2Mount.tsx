// AppV2Mount — production entry point for the V2 review surface.
//
// Responsibilities:
//  - Parse the PR ref from URL query params (?owner=&repo=&pr=).
//  - Read the existing GitHub token from chrome.storage.local
//    (populated by the legacy auth flow).
//  - Call bootstrapPullRequest() to assemble the data layer.
//  - Render <AppV2 /> once bootstrapping is done; surface
//    missing-PR / missing-token / bootstrap errors clearly.
//
// V2 is reachable via `?v=2` on the review URL. Until phase 6i
// removes the legacy App, this component is the parallel entry
// users opt into; ordinary URLs still land on the legacy App.

import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { bootstrapPullRequest, type BootstrappedPullRequest } from "../../lib/pr/bootstrap";
import type { PrRef } from "../../lib/pr/github-transport";
import { AppV2 } from "./AppV2";

const TOKEN_KEY = "github_token";

type BootState =
  | { kind: "loading" }
  | { kind: "missing-pr" }
  | { kind: "missing-token" }
  | { kind: "error"; message: string }
  | { kind: "ready"; pr: BootstrappedPullRequest };

export function AppV2Mount() {
  const [state, setState] = useState<BootState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ref = parsePrRef();
      if (!ref) {
        if (!cancelled) setState({ kind: "missing-pr" });
        return;
      }
      const token = await getToken();
      if (!token) {
        if (!cancelled) setState({ kind: "missing-token" });
        return;
      }
      try {
        const pr = await bootstrapPullRequest({
          token,
          prRef: ref,
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
  }, []);

  if (state.kind === "loading") {
    return <BootGate>Loading…</BootGate>;
  }
  if (state.kind === "missing-pr") {
    return (
      <BootGate>
        Missing PR reference. Open the review page with
        <code> ?owner=…&repo=…&pr=…&v=2</code>.
      </BootGate>
    );
  }
  if (state.kind === "missing-token") {
    return (
      <BootGate>
        No GitHub token found. Sign in via the legacy app (drop the
        <code> &v=2</code> from the URL) once, then come back.
      </BootGate>
    );
  }
  if (state.kind === "error") {
    return (
      <BootGate>
        <span>Could not start the V2 review surface.</span>
        <pre className="appv2__boot-error">{state.message}</pre>
      </BootGate>
    );
  }
  return <AppV2 repository={state.pr.repository} refresh={state.pr.refresh} />;
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

async function getToken(): Promise<string | null> {
  const result = await browser.storage.local.get(TOKEN_KEY);
  const token = result[TOKEN_KEY];
  return typeof token === "string" && token.length > 0 ? token : null;
}
