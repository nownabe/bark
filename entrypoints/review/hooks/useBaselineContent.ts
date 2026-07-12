// Baseline file content for the R10 redline overlay (§7.10).
//
// The redline compares the currently selected file at HEAD against the same
// file at a *baseline* commit (the viewer's last-seen SHA, or the PR base ref).
// This hook fetches that baseline content through the data layer's
// `fetchFileContent` (the very same primitive the head load uses in
// useSelectedFileContent), keyed on (baselineSha, path). It re-fetches when
// either changes.
//
// It intentionally does NOT go through the RemoteState refresh cycle: the
// baseline SHA and file switch independently of a mutation refresh, and the
// derived redline is a pure read-only overlay — a direct fetch keeps the change
// small and keeps redline off the mutation path.
//
// Result:
//   - null while there's nothing to fetch (no baseline sha → no redline),
//   - null when the file didn't exist at the baseline commit (404, non-fatal),
//   - the baseline source string once fetched.
import { useEffect, useState } from "react";
import type { PrRef } from "../../../lib/github";
import { GitHubApiError, type GitHubClient } from "../../../lib/pr/github-api";
import { fetchFileContent } from "../../../lib/pr/remote-fetcher";

/** The selected file's content at the baseline commit, or null when there is
 *  no baseline / the file is absent there. */
export function useBaselineContent(
  client: GitHubClient | null,
  ref: PrRef | null,
  baselineSha: string | null,
  selectedPath: string | null,
): string | null {
  const [baseline, setBaseline] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !ref || !baselineSha || !selectedPath) {
      setBaseline(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const text = (await fetchFileContent(client, ref, baselineSha, selectedPath)).source;
        if (!cancelled) setBaseline(text);
      } catch (e) {
        // A 404 means the file did not exist at the baseline commit — there is
        // nothing to diff against, so fall back to no redline rather than
        // surfacing an error. Any other failure also degrades gracefully to no
        // overlay (the head content still renders normally).
        if (!cancelled) setBaseline(null);
        if (!(e instanceof GitHubApiError && e.status === 404)) {
          console.warn("Bark: baseline content fetch failed", e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, ref?.owner, ref?.repo, ref?.number, baselineSha, selectedPath]);

  return baseline;
}
