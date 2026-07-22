// Bootstrap — composes the data layer for a single PR.
//
// Given an auth token, a PrRef, and a browser-storage API, this returns a
// ready-to-use PullRequestRepository plus a refresh() function the
// entrypoint calls on bootstrap and on the refresh triggers from ADR 0005
// (visibility-change, debug button, post-mutation).
//
// Once App.tsx is rewritten in phase 6c, the entrypoint code path becomes:
//
//   const { repository, refresh } = await bootstrapPullRequest(opts);
//   return (
//     <RepositoryProvider repo={repository}>
//       <SnackbarProvider>
//         <App refresh={refresh} />
//       </SnackbarProvider>
//     </RepositoryProvider>
//   );

import { BrowserStorageAdapter, type BrowserStorageAPI, prStorageKey } from "./chrome-storage";
import { buildIsInDiff } from "./diff";
import type { GitHubClient } from "./github-api";
import { createGitHubTransport, type PrRef } from "./github-transport";
import { fetchChangedFiles, fetchRemoteState } from "./remote-fetcher";
import { PullRequestRepository } from "./repository";
import type { Comment, LocalState } from "./types";

export type BootstrapOptions = {
  token: string;
  prRef: PrRef;
  storage: BrowserStorageAPI;
  /** Override for tests; default is `globalThis.fetch`. */
  fetch?: typeof fetch;
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
  });

  await repository.hydrate();

  async function refresh(): Promise<void> {
    const fileContentTargets = anchorTargets(repository.getLocalState());
    const [remoteState, changedFiles] = await Promise.all([
      fetchRemoteState(client, opts.prRef, { fileContentTargets }),
      fetchChangedFiles(client, opts.prRef),
    ]);
    isInDiffImpl = buildIsInDiff(changedFiles);
    // Attach the listing so AppState can derive the changed-.md selector
    // from the Repository (RemoteState.changedFiles is remote-only).
    await repository.setRemoteState({ ...remoteState, changedFiles });
  }

  await refresh();

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
