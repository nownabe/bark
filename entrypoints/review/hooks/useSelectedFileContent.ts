// Per-file content load (Pack B / R8d).
//
// Owns the source / baseSource pair plus the legacy "Effect 2": fetch
// the file's content from GitHub whenever (ref, headSha, selectedPath)
// becomes available, restore any persisted SuggestionEdit for that
// path, normalise the stored edit against the freshly-fetched base if
// they drifted, and flush pending debounced writes before swapping
// files / unmounting.
//
// The hook owns no draft-layer state itself: per-path
// SuggestionEdit / SuggestionComments updates and the "flush before
// teardown" handoff land in the caller via the `callbacks` bag, so
// useSuggestionEdits stays the canonical home for that map.

import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import type { SuggestionEdit } from "../../../lib/drafts";
import type { GitHubClient, PrRef } from "../../../lib/github";
import { errMessage } from "../uiHelpers";

export type SelectedFileContentClient = Pick<GitHubClient, "getFileContent">;

export type SelectedFileContentDeps = {
  /** Read fresh — avoid a restore race with useSuggestionEdits's own
   *  effect. The result is used to look up just this path's edit. */
  listSuggestionEdits: (ref: PrRef) => Promise<Record<string, SuggestionEdit>>;
};

export type SelectedFileContentCallbacks = {
  /** True while the fetch is in flight. The parent owns the global
   *  loading flag (used elsewhere too), so we hand it back. */
  onLoadingChange: (loading: boolean) => void;
  onError: (message: string) => void;
  /** Fired once the GET succeeds — the parent applies its own
   *  per-path SuggestionEdit / SuggestionComments restore. */
  onLoaded: (info: { path: string; text: string; edit: SuggestionEdit | undefined }) => void;
  /** Fired on effect teardown (switching files / unmount). The parent
   *  flushes any pending debounced edit writes here. */
  onCleanup: () => void;
};

export type FileSource = {
  source: string;
  baseSource: string;
  setSource: Dispatch<SetStateAction<string>>;
  setBaseSource: Dispatch<SetStateAction<string>>;
};

export function useSelectedFileContent(
  client: SelectedFileContentClient | null,
  ref: PrRef | null,
  headSha: string | null,
  selectedPath: string | null,
  initialSource: string,
  deps: SelectedFileContentDeps,
  callbacks: SelectedFileContentCallbacks,
): FileSource {
  const [source, setSource] = useState<string>(initialSource);
  const [baseSource, setBaseSource] = useState<string>(initialSource);

  // Pin the latest callbacks via a ref so a new identity each render
  // doesn't re-fire the fetch effect.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const listRef = useRef(deps.listSuggestionEdits);
  listRef.current = deps.listSuggestionEdits;

  useEffect(() => {
    if (!client || !ref || !headSha || !selectedPath) return;
    let cancelled = false;
    callbacksRef.current.onLoadingChange(true);
    (async () => {
      try {
        const text = await client.getFileContent(ref, selectedPath, headSha);
        const edits = await listRef.current(ref);
        if (cancelled) return;
        const edit = edits[selectedPath];
        setBaseSource(text);
        setSource(edit?.source ?? text);
        callbacksRef.current.onLoaded({ path: selectedPath, text, edit });
      } catch (e) {
        if (!cancelled) callbacksRef.current.onError(errMessage(e));
      } finally {
        if (!cancelled) callbacksRef.current.onLoadingChange(false);
      }
    })();
    return () => {
      cancelled = true;
      // Persist any pending edit before switching files / unmounting,
      // so a quick reload right after an edit still restores it.
      callbacksRef.current.onCleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ref?.owner, ref?.repo, ref?.number, headSha, selectedPath]);

  return { source, baseSource, setSource, setBaseSource };
}
