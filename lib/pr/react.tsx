// React integration for the PullRequestRepository.
//
// Layered architecture (ADR 0001 §4):
//   - React **reads** AppState only (`useAppStateFromRepository`).
//   - React **writes** through the Repository the surface holds.
//   - LocalState / RemoteState are Repository-internal — they MUST NOT be
//     read from React components directly.

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { type AppState, deriveAppState } from "./appstate";
import type { PullRequestRepository } from "./repository";

const NO_OP_UNSUBSCRIBE = () => {};

/** AppState derived from the subscribed LocalState + RemoteState of the
 *  given repository. `App.tsx` bootstraps the repository as a local state
 *  of the surface itself and passes it here.
 *
 *  Returns `null` when `repo` is null (the surface is still warming up:
 *  no PR, no token, or bootstrap in flight). The hook always subscribes
 *  — passing `null` for `repo` does NOT change the hook call order, so
 *  it's safe to flip between repo and null on subsequent renders. */
export function useAppStateFromRepository(repo: PullRequestRepository | null): AppState | null {
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
    return deriveAppState(local, remote);
  }, [local, remote]);
}
