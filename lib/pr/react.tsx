// React integration for the PullRequestRepository.
//
// Layered architecture (ADR 0001 §4):
//   - React **reads** AppState only (`useAppState`).
//   - React **writes** through the Repository (`useRepository`).
//   - LocalState / RemoteState are Repository-internal — they MUST NOT be
//     read from React components directly. The two `useLocal/RemoteState`
//     hooks below are file-private helpers that exist so `useAppState` can
//     subscribe to the underlying snapshots; they are intentionally not
//     exported.

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
