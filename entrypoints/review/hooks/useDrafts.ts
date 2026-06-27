// Pending comment / reply drafts (Pack B / R8a).
//
// Owns the legacy `PendingDraft[]` list plus its IndexedDB persistence:
//   - restore from storage whenever the active PR changes
//   - persist atomically on every replacement (replaceAndPersist)
//   - clear the in-memory list without touching storage (reset),
//     used by the parent's logout flow
//
// suggestionEdits, suggestionComments, dismissed, and the per-file
// content-load effect intentionally stay outside this hook for now;
// they'll be lifted in R8b/c so each piece can move with its own
// tests instead of one omnibus refactor.

import { useEffect, useState } from "react";
import type { PrRef } from "../../../lib/github";
import type { PendingDraft } from "../../../lib/drafts";

export type DraftsDeps = {
  listDrafts: (ref: PrRef) => Promise<PendingDraft[]>;
  saveDrafts: (ref: PrRef, drafts: PendingDraft[]) => Promise<void>;
};

export type Drafts = {
  drafts: PendingDraft[];
  /** Replace the in-memory list AND persist it atomically. The legacy
   *  call sites were always doing this pair together. */
  replaceAndPersist: (next: PendingDraft[]) => Promise<void>;
  /** Clear local state without touching storage. Used on logout. */
  reset: () => void;
};

export function useDrafts(ref: PrRef | null, deps: DraftsDeps): Drafts {
  const [drafts, setDrafts] = useState<PendingDraft[]>([]);

  useEffect(() => {
    if (!ref) {
      setDrafts([]);
      return;
    }
    let cancelled = false;
    deps.listDrafts(ref).then((d) => {
      if (!cancelled) setDrafts(d);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.owner, ref?.repo, ref?.number]);

  const replaceAndPersist = async (next: PendingDraft[]) => {
    setDrafts(next);
    if (ref) await deps.saveDrafts(ref, next);
  };

  const reset = () => setDrafts([]);

  return { drafts, replaceAndPersist, reset };
}
