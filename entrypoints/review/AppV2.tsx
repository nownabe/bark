// V2 review surface, built on the new data layer (lib/pr/).
//
// This component is intentionally separate from the legacy `App.tsx`:
// the data layer rewrite (phases 1-6b) is complete and verified by
// unit / integration tests; here we exercise it in a real React tree
// without disturbing the live extension. Subsequent phases will grow
// this UI feature-by-feature until it can replace the legacy App.
//
// The component expects a pre-bootstrapped `PullRequestRepository` and
// a `refresh()` function (see `lib/pr/bootstrap.ts`). It does not call
// `bootstrapPullRequest` itself so the auth-token / browser-storage
// integration can be supplied separately by the entrypoint.

import { useEffect, useMemo, useState } from "react";
import { RepositoryProvider, useAppState } from "../../lib/pr/react";
import type { PullRequestRepository } from "../../lib/pr/repository";
import { SnackbarProvider, useSnackbar } from "./components/Snackbar";

export type AppV2Props = {
  repository: PullRequestRepository;
  refresh: () => Promise<void>;
};

/** Top-level V2 component. Wraps children in the providers the rest of
 *  the tree needs and renders the review surface. */
export function AppV2({ repository, refresh }: AppV2Props) {
  return (
    <RepositoryProvider repo={repository}>
      <SnackbarProvider>
        <ReviewSurface refresh={refresh} />
      </SnackbarProvider>
    </RepositoryProvider>
  );
}

/** A first cut of the V2 review surface. Renders PR metadata, the
 *  viewer's role, and the list of threads with their comments. */
function ReviewSurface({ refresh }: { refresh: () => Promise<void> }) {
  // For now `isInDiff` defaults to false here; the entrypoint wires it
  // through the bootstrapped repository's `runSyncCycles` already. Once
  // we display in-diff state in the sidebar we will read it from a
  // memoised closure tied to RemoteState.
  const ctx = useMemo(() => ({ isInDiff: () => false }), []);
  const state = useAppState(ctx);
  const snackbar = useSnackbar();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } catch (e) {
      snackbar.show(`Could not refresh from GitHub. (${errMessage(e)})`);
    } finally {
      setRefreshing(false);
    }
  };

  // Per ADR 0005 §1, refresh on visibility-change after the tab has been
  // hidden for ≥ 30 s. The threshold avoids fetching on every brief tab
  // switch while still picking up "come back tomorrow" returns.
  useVisibilityRefresh(onRefresh);

  return (
    <main className="appv2">
      <header className="appv2__header">
        <PrHeading pullRequest={state.pullRequest} viewer={state.viewer} role={state.role} />
        <button type="button" className="btn btn--sm" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <section className="appv2__threads" data-testid="threads">
        <h2 className="appv2__section-title">Threads ({state.threadGroups.length})</h2>
        {state.threadGroups.length === 0 ? (
          <p className="appv2__empty">No threads yet.</p>
        ) : (
          <ul className="appv2__thread-list">
            {state.threadGroups.map((group) => (
              <li key={group.thread.id} className="appv2__thread">
                <span className="appv2__thread-id">{group.thread.id}</span>
                {group.thread.resolved && (
                  <span className="appv2__badge appv2__badge--resolved">resolved</span>
                )}
                <ul className="appv2__comment-list">
                  {group.comments.map((view) => (
                    <li key={view.comment.id} className="appv2__comment">
                      <span className="appv2__author">@{view.comment.author.login}</span>
                      <span className="appv2__body">{view.comment.body}</span>
                      {view.isMyDraft && (
                        <span className="appv2__badge appv2__badge--draft">draft</span>
                      )}
                      {view.kind === "suggestion" && (
                        <span className="appv2__badge appv2__badge--suggestion">suggestion</span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function PrHeading({
  pullRequest,
  viewer,
  role,
}: {
  pullRequest: ReturnType<typeof useAppState>["pullRequest"];
  viewer: ReturnType<typeof useAppState>["viewer"];
  role: ReturnType<typeof useAppState>["role"];
}) {
  if (!pullRequest) {
    return <p className="appv2__loading">Loading PR…</p>;
  }
  return (
    <div className="appv2__pr-heading">
      <h1 className="appv2__title">{pullRequest.title}</h1>
      <p className="appv2__meta">
        <span>
          {pullRequest.owner}/{pullRequest.repo}#{pullRequest.number}
        </span>
        {viewer && (
          <>
            {" · "}
            <span>
              viewer @{viewer.login} ({role ?? "—"})
            </span>
          </>
        )}
      </p>
    </div>
  );
}

const VISIBILITY_THRESHOLD_MS = 30_000;

/** Re-fetch on tab visibility change, gated by a threshold per ADR 0005 §1. */
function useVisibilityRefresh(onRefresh: () => Promise<void>) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    let hiddenAt = 0;
    const handle = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
      } else if (document.visibilityState === "visible" && hiddenAt > 0) {
        if (Date.now() - hiddenAt >= VISIBILITY_THRESHOLD_MS) {
          void onRefresh();
        }
        hiddenAt = 0;
      }
    };
    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, [onRefresh]);
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
