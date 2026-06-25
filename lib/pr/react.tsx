// React integration for the PullRequestRepository.
//
// Components access the Repository through a Context provider and read
// state via hooks built on `useSyncExternalStore`. `useAppState` runs the
// pure `deriveAppState` derivation on top of the subscribed LocalState +
// RemoteState.

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

export function useLocalState(): LocalState {
  const repo = useRepository();
  const subscribe = useCallback((cb: () => void) => repo.subscribe(cb), [repo]);
  const getSnapshot = useCallback(() => repo.getLocalState(), [repo]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useRemoteState(): RemoteState {
  const repo = useRepository();
  const subscribe = useCallback((cb: () => void) => repo.subscribe(cb), [repo]);
  const getSnapshot = useCallback(() => repo.getRemoteState(), [repo]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Derive AppState from the subscribed LocalState + RemoteState. The
 *  `ctx` argument should be memoised by the caller — a new identity on
 *  every render forces a re-derivation each time. */
export function useAppState(ctx: DeriveContext): AppState {
  const local = useLocalState();
  const remote = useRemoteState();
  return useMemo(() => deriveAppState(local, remote, ctx), [local, remote, ctx]);
}
