// Reviewer / author per-file edits (Pack B / R8b).
//
// Owns the two related maps the legacy App tracked side by side:
//   - suggestionEdits[path]      = the document + base + attached comments
//   - suggestionComments[cid]    = the body for each pending suggestion
// plus the debounced, ref-aware persistence the legacy used (a per-path
// pending-write buffer flushed via a 400 ms timer, with read-modify-
// write semantics so a path another tab edited mid-flight is preserved).
//
// Per-file content load (Effect 2 in App.tsx) stays in the parent for
// now — it touches drafts / source / baseSource state that isn't owned
// by this hook. The parent calls setSuggestionEdits / setSuggestionComments
// while it runs that effect.

import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import type { SuggestionEdit } from "../../../lib/drafts";
import type { PrRef } from "../../../lib/github";
import { isMeaningfulEdit } from "../../../lib/suggest";

const SAVE_DEBOUNCE_MS = 400;

export type SuggestionEditsDeps = {
  listSuggestionEdits: (ref: PrRef) => Promise<Record<string, SuggestionEdit>>;
  saveSuggestionEdits: (ref: PrRef, edits: Record<string, SuggestionEdit>) => Promise<void>;
};

export type SuggestionEditsAPI = {
  suggestionEdits: Record<string, SuggestionEdit>;
  suggestionComments: Record<string, string>;
  setSuggestionEdits: Dispatch<SetStateAction<Record<string, SuggestionEdit>>>;
  setSuggestionComments: Dispatch<SetStateAction<Record<string, string>>>;
  /** Update the per-path edit (debounced storage write). Pass src === base
   *  to clear that path. `baseSha` records the head `base` was fetched at
   *  (see SuggestionEdit.baseSha). */
  persistSuggestionEdit: (
    path: string,
    src: string,
    base: string,
    comments: Record<string, string>,
    baseSha?: string,
  ) => void;
  /** Flush any pending debounced writes immediately. Used before submit. */
  flushPendingWrites: () => Promise<void>;
  /** Wipe every per-path edit (in memory AND in storage) and cancel any
   *  pending debounced writes. Used right after a successful submit. */
  discardAllPersisted: () => Promise<void>;
  /** Reset in-memory state without touching storage (used on logout). */
  reset: () => void;
};

export function useSuggestionEdits(
  ref: PrRef | null,
  deps: SuggestionEditsDeps,
): SuggestionEditsAPI {
  const [suggestionEdits, setSuggestionEdits] = useState<Record<string, SuggestionEdit>>({});
  const [suggestionComments, setSuggestionComments] = useState<Record<string, string>>({});
  // Per-path edits awaiting a debounced write. `null` means "delete that
  // path on flush". Accumulated by path — switching files mid-debounce
  // can never drop another file's pending write.
  const pendingEditWrites = useRef<Record<string, SuggestionEdit | null>>({});
  const editSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore the persisted map on ref change; clear on null ref.
  useEffect(() => {
    if (!ref) {
      setSuggestionEdits({});
      return;
    }
    let cancelled = false;
    deps.listSuggestionEdits(ref).then((e) => {
      if (!cancelled) setSuggestionEdits(e);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.owner, ref?.repo, ref?.number]);

  // Read-modify-write the accumulated per-path edits to storage, so a
  // path edited elsewhere (or another tab) is never clobbered. Clears
  // the pending buffer.
  const flushPendingWrites = async () => {
    if (!ref) return;
    const writes = pendingEditWrites.current;
    pendingEditWrites.current = {};
    if (editSaveTimer.current) {
      clearTimeout(editSaveTimer.current);
      editSaveTimer.current = null;
    }
    if (Object.keys(writes).length === 0) return;
    const stored = await deps.listSuggestionEdits(ref);
    for (const [p, edit] of Object.entries(writes)) {
      if (edit) stored[p] = edit;
      else delete stored[p];
    }
    await deps.saveSuggestionEdits(ref, stored);
  };

  const persistSuggestionEdit = (
    path: string,
    src: string,
    base: string,
    comments: Record<string, string>,
    baseSha?: string,
  ) => {
    if (!ref) return;
    // A trailing-newline-only difference is not a submittable change (issue
    // #194): persisting it would strand the reviewer in an unsubmittable
    // tracked-changes state, so clear the path instead.
    const edit: SuggestionEdit | null = isMeaningfulEdit(base, src)
      ? { source: src, base, ...(baseSha ? { baseSha } : {}), comments }
      : null;
    // Keep the in-memory all-files map fresh immediately (storage write
    // is debounced below) so the submit count / modal reflect the
    // latest edit.
    setSuggestionEdits((prev) => {
      if (!edit && !(path in prev)) return prev;
      const next = { ...prev };
      if (edit) next[path] = edit;
      else delete next[path];
      return next;
    });
    pendingEditWrites.current[path] = edit;
    if (editSaveTimer.current) clearTimeout(editSaveTimer.current);
    editSaveTimer.current = setTimeout(() => void flushPendingWrites(), SAVE_DEBOUNCE_MS);
  };

  const discardAllPersisted = async () => {
    setSuggestionEdits({});
    pendingEditWrites.current = {};
    if (editSaveTimer.current) {
      clearTimeout(editSaveTimer.current);
      editSaveTimer.current = null;
    }
    if (ref) await deps.saveSuggestionEdits(ref, {});
  };

  const reset = () => {
    setSuggestionEdits({});
    setSuggestionComments({});
    pendingEditWrites.current = {};
    if (editSaveTimer.current) {
      clearTimeout(editSaveTimer.current);
      editSaveTimer.current = null;
    }
  };

  return {
    suggestionEdits,
    suggestionComments,
    setSuggestionEdits,
    setSuggestionComments,
    persistSuggestionEdit,
    flushPendingWrites,
    discardAllPersisted,
    reset,
  };
}
