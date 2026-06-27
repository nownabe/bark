// React integration for the PullRequestRepository.
//
// Layered architecture (ADR 0001 §4):
//   - React **reads** AppState only (`useAppState` / `useAppStateFromRepository`).
//   - React **writes** through the Repository (`useRepository`).
//   - LocalState / RemoteState are Repository-internal — they MUST NOT be
//     read from React components directly. The two `useLocal/RemoteState`
//     hooks below are file-private helpers that exist so `useAppState` can
//     subscribe to the underlying snapshots; they are intentionally not
//     exported.
//
// Two `useAppState` flavours, same semantics:
//   - `useAppState(ctx)`            — for a tree under `<RepositoryProvider>`.
//   - `useAppStateFromRepository(repo, ctx)` — pass the repository directly,
//     so a single component (the legacy `App.tsx` during the
//     legacy-on-new-data-layer rollout) can read AppState without
//     restructuring around the Provider. Returns `null` when `repo` is null.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import { type AppState, deriveAppState, type DeriveContext } from "./appstate";
import type { PullRequestRepository } from "./repository";
import type { LocalState, RemoteState } from "./types";

const RepositoryContext = createContext<PullRequestRepository | null>(null);

export function RepositoryProvider({
  repo,
  children,
}: {
  repo: PullRequestRepository;
  children: ReactNode;
}) {
  return <RepositoryContext.Provider value={repo}>{children}</RepositoryContext.Provider>;
}

export function useRepository(): PullRequestRepository {
  const repo = useContext(RepositoryContext);
  if (!repo) {
    throw new Error("useRepository requires a <RepositoryProvider /> ancestor");
  }
  return repo;
}

function useLocalStateInternal(): LocalState {
  const repo = useRepository();
  const subscribe = useCallback((cb: () => void) => repo.subscribe(cb), [repo]);
  const getSnapshot = useCallback(() => repo.getLocalState(), [repo]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

function useRemoteStateInternal(): RemoteState {
  const repo = useRepository();
  const subscribe = useCallback((cb: () => void) => repo.subscribe(cb), [repo]);
  const getSnapshot = useCallback(() => repo.getRemoteState(), [repo]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Derive AppState from the subscribed LocalState + RemoteState. The
 *  `ctx` argument should be memoised by the caller — a new identity on
 *  every render forces a re-derivation each time. */
export function useAppState(ctx: DeriveContext): AppState {
  const local = useLocalStateInternal();
  const remote = useRemoteStateInternal();
  return useMemo(() => deriveAppState(local, remote, ctx), [local, remote, ctx]);
}

const NO_OP_UNSUBSCRIBE = () => {};

/** Same semantics as `useAppState(ctx)` but takes the repository
 *  directly. Used by callers that can't sit under a
 *  `<RepositoryProvider>` — the legacy `App.tsx` during the
 *  legacy-on-new-data-layer rollout, where the bootstrapped repository
 *  is a local state of the surface itself.
 *
 *  Returns `null` when `repo` is null (the surface is still warming up:
 *  no PR, no token, or bootstrap in flight). The hook always subscribes
 *  — passing `null` for `repo` does NOT change the hook call order, so
 *  it's safe to flip between repo and null on subsequent renders. */
export function useAppStateFromRepository(
  repo: PullRequestRepository | null,
  ctx: DeriveContext,
): AppState | null {
  const subscribe = useCallback(
    (cb: () => void) => (repo ? repo.subscribe(cb) : NO_OP_UNSUBSCRIBE),
    [repo],
  );
  const getLocal = useCallback(() => (repo ? repo.getLocalState() : null), [repo]);
  const getRemote = useCallback(() => (repo ? repo.getRemoteState() : null), [repo]);
  const local = useSyncExternalStore(subscribe, getLocal);
  const remote = useSyncExternalStore(subscribe, getRemote);
  return useMemo(() => {
    if (!local || !remote) return null;
    return deriveAppState(local, remote, ctx);
  }, [local, remote, ctx]);
}
