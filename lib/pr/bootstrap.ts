// Bootstrap — composes the data layer for a single PR.
//
// Given an auth token, a PrRef, and a browser-storage API, this returns a
// ready-to-use PullRequestRepository plus a refresh() function the
// entrypoint calls on bootstrap and on the refresh triggers from ADR 0005
// (visibility-change, debug button, post-mutation).
//
// The review surface keeps both as its own state and reads AppState via
// `useAppStateFromRepository(repository)`.

import {
  BrowserStorageAdapter,
  type BrowserStorageAPI,
  evictStalePrStorage,
  prStorageKey,
  prStorageKeys,
} from "./chrome-storage";
import { buildIsInDiff } from "./diff";
import type { GitHubClient } from "./github-api";
import { createGitHubTransport } from "./github-transport";
import { fetchChangedFiles, fetchRemoteState } from "./remote-fetcher";
import { PullRequestRepository } from "./repository";
import type { Comment, LocalState, PrRef, User } from "./types";

export type BootstrapOptions = {
  token: string;
  prRef: PrRef;
  storage: BrowserStorageAPI;
  /** Override for tests; default is `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Reports a failed local persist (quota, transient error) to the UI. */
  onPersistError?: (error: unknown) => void;
};

export type BootstrappedPullRequest = {
  /** Ready-to-use Repository, already hydrated from local storage and
   *  populated by an initial GitHub refresh. */
  repository: PullRequestRepository;
  /** Refresh the RemoteState + diff data from GitHub and merge into
   *  LocalState. Called by the visibility-change handler, the debug
   *  refresh button, and by Repository internals post-mutation. */
  refresh: () => Promise<void>;
};

export async function bootstrapPullRequest(
  opts: BootstrapOptions,
): Promise<BootstrappedPullRequest> {
  const client: GitHubClient = { token: opts.token, fetch: opts.fetch };

  const key = prStorageKey(opts.prRef.owner, opts.prRef.repo, opts.prRef.number);
  const storageAdapter = new BrowserStorageAdapter(key, opts.storage);
  const transport = createGitHubTransport(client, opts.prRef);

  // The raw changed-file listing rides into RemoteState.changedFiles (per
  // ADR 0003 §5 the current diff is fetched "as part of RemoteState");
  // only this derived isInDiff *predicate* stays outside, as
  // a closure rebuilt on every refresh. Intervening calls use the most
  // recent build.
  let isInDiffImpl: (c: Comment) => boolean = () => false;

  const repository = new PullRequestRepository({
    storage: storageAdapter,
    transport,
    isInDiff: (c) => isInDiffImpl(c),
    onPersistError: opts.onPersistError,
  });

  await repository.hydrate();

  // The viewer identity changes only on re-auth, so it is fetched on the
  // first round and reused by every subsequent refresh (ADR 0005 §2).
  let knownViewer: User | undefined;

  // The fetch runs inside the Repository's lock, so it cannot read a head
  // that an Executor write then replaces, and concurrent triggers coalesce
  // (issue #281, ADR 0005 §3). isInDiffImpl and knownViewer are therefore
  // updated under the lock too.
  function refresh(): Promise<void> {
    return repository.refresh(async () => {
      const fileContentTargets = anchorTargets(repository.getLocalState());
      const [remoteState, changedFiles] = await Promise.all([
        fetchRemoteState(client, opts.prRef, { fileContentTargets, viewer: knownViewer }),
        fetchChangedFiles(client, opts.prRef),
      ]);
      knownViewer = remoteState.viewer ?? undefined;
      isInDiffImpl = buildIsInDiff(changedFiles);
      // Attach the listing so AppState can derive the changed-.md selector
      // from the Repository (RemoteState.changedFiles is remote-only).
      return { ...remoteState, changedFiles };
    });
  }

  await refresh();

  // Fire-and-forget: keeping storage bounded must never delay or fail the load.
  // Hydration already happened, so a merged PR still shows its stored work for
  // this session; only the persisted copy goes (ADR 0001 §2).
  void evictStalePrStorage(opts.storage, {
    key,
    merged: repository.getRemoteState().pullRequest?.merged === true,
    keys: prStorageKeys(opts.prRef.owner, opts.prRef.repo, opts.prRef.number),
  }).catch(opts.onPersistError);

  return { repository, refresh };
}

/** Unique `(anchor.sha, path)` pairs needed for re-anchoring derivation.
 *  Foreign comments (not authored by Bark) carry no metadata and arrive
 *  with `anchor.sha === ""`; some also have `path === ""` (issue
 *  comments). Skip them — fetching `/contents/<path>?ref=` would 404,
 *  and re-anchoring needs a concrete sha anyway. */
function anchorTargets(local: LocalState): Array<{ sha: string; path: string }> {
  const seen = new Set<string>();
  const out: Array<{ sha: string; path: string }> = [];
  for (const c of local.comments) {
    if (!c.anchor.sha || !c.path) continue;
    const k = `${c.anchor.sha}\0${c.path}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ sha: c.anchor.sha, path: c.path });
    }
  }
  return out;
}
