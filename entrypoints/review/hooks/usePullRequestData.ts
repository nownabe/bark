// Initial PR-level data fetch (Pack B / R7).
//
// Owns the state that comes back from "give me everything you need to
// know about the PR" — the PullInfo / changed files / head SHA + ref /
// the viewer's login (so role can be derived in the parent) — plus the
// fetch lifecycle around it (loading, error, the 404/403 -> install
// flag, and a `reload()` trigger).
//
// Per-file content (source / baseSource), the SuggestionEdit restore,
// and the selectedPath bookkeeping intentionally stay in App.tsx for
// now: they read draft-layer state that R8 (useDrafts) will lift out.
// Splitting that here would only push the coupling around.

import { useEffect, useState } from "react";
import {
  type ChangedFile,
  GitHubApiError,
  type GitHubClient,
  type PrRef,
  type PullInfo,
} from "../../../lib/github";
import { errMessage } from "../uiHelpers";

/** Just enough of GitHubClient for this hook; lets tests pass a plain
 *  object without having to construct a real class instance. */
export type PullRequestClient = Pick<
  GitHubClient,
  "getPull" | "listMarkdownFiles" | "getAuthenticatedUser"
>;

export type PullRequestData = {
  pull: PullInfo | null;
  files: ChangedFile[];
  headSha: string | null;
  headRef: string | null;
  /** GitHub login of the authenticated user, or null until it has
   *  successfully been fetched. Used by App to derive role. */
  viewerLogin: string | null;
  /** True when the initial fetch failed with 404 or 403 (most often
   *  "GitHub App not installed on this repo"). */
  needsInstall: boolean;
  error: string | null;
  loading: boolean;
  /** Bump the reload trigger so the effect re-runs. */
  reload: () => void;
  /** Wipe every field — used by the parent's logout / token-clear flow. */
  reset: () => void;
  /** Setters exposed because the parent updates these after a commit
   *  (new head SHA) and during downstream submit / save lifecycles
   *  (loading / error). Keeping the underlying useStates inside the
   *  hook is fine as long as App can poke them when it acts. */
  setHeadSha: (sha: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (msg: string | null) => void;
};

export function usePullRequestData(
  client: PullRequestClient | null,
  ref: PrRef | null,
): PullRequestData {
  const [pull, setPull] = useState<PullInfo | null>(null);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [headSha, setHeadSha] = useState<string | null>(null);
  const [headRef, setHeadRef] = useState<string | null>(null);
  const [viewerLogin, setViewerLogin] = useState<string | null>(null);
  const [needsInstall, setNeedsInstall] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!client || !ref) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNeedsInstall(false);
    (async () => {
      try {
        const info = await client.getPull(ref);
        const md = await client.listMarkdownFiles(ref);
        if (cancelled) return;
        setPull(info);
        setHeadSha(info.headSha);
        setHeadRef(info.headRef);
        setFiles(md);
        try {
          const viewer = await client.getAuthenticatedUser();
          if (!cancelled) setViewerLogin(viewer.login);
        } catch (identityError) {
          // Identity lookup failed (network / missing scope). Don't fail
          // the whole load — only the author affordance depends on it.
          // (#83)
          console.warn("Bark: viewer identity lookup failed", identityError);
        }
      } catch (e) {
        if (cancelled) return;
        setError(errMessage(e));
        setNeedsInstall(e instanceof GitHubApiError && (e.status === 404 || e.status === 403));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ref?.owner, ref?.repo, ref?.number, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  const reset = () => {
    setPull(null);
    setFiles([]);
    setHeadSha(null);
    setHeadRef(null);
    setViewerLogin(null);
    setNeedsInstall(false);
    setError(null);
  };

  return {
    pull,
    files,
    headSha,
    headRef,
    viewerLogin,
    needsInstall,
    error,
    loading,
    reload,
    reset,
    setHeadSha,
    setLoading,
    setError,
  };
}
