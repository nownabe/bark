// Author's accept / reject decisions on submitted suggestions: a plain map
// + a restore effect + the "set + persist" actions. The id →
// SuggestionDecision mapping is keyed by the submitted comment's REST id
// (stringified) and is used by the review list to hide accepted/rejected
// suggestions and by submit flows to materialise accepted ones into actual
// commits.

import { useEffect, useState } from "react";
import type { SuggestionDecision } from "../../../lib/drafts";
import type { PrRef } from "../../../lib/pr/types";

export type DismissedDeps = {
  listDismissedSuggestions: (ref: PrRef) => Promise<Record<string, SuggestionDecision>>;
  saveDismissedSuggestions: (
    ref: PrRef,
    dismissed: Record<string, SuggestionDecision>,
  ) => Promise<void>;
  clearAcceptedDecisions: (ref: PrRef, commentIds: number[]) => Promise<void>;
};

export type DismissedSuggestions = {
  dismissed: Record<string, SuggestionDecision>;
  /** Set + persist a single decision atomically. */
  setDecision: (id: number, decision: SuggestionDecision) => Promise<void>;
  /** Drop the given comment ids' accepted decisions from state and storage —
   *  the bulk purge a Submit (committed + resolved) or a Discard all performs. */
  clearAccepted: (commentIds: number[]) => Promise<void>;
  /** Clear local state without touching storage (used on logout). */
  reset: () => void;
};

export function useDismissedSuggestions(
  ref: PrRef | null,
  deps: DismissedDeps,
): DismissedSuggestions {
  const [dismissed, setDismissed] = useState<Record<string, SuggestionDecision>>({});

  useEffect(() => {
    if (!ref) {
      setDismissed({});
      return;
    }
    let cancelled = false;
    deps.listDismissedSuggestions(ref).then((d) => {
      if (!cancelled) setDismissed(d);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.owner, ref?.repo, ref?.number]);

  const setDecision = async (id: number, decision: SuggestionDecision) => {
    const next = { ...dismissed, [id]: decision };
    setDismissed(next);
    if (ref) await deps.saveDismissedSuggestions(ref, next);
  };

  const clearAccepted = async (commentIds: number[]) => {
    const drop = new Set(commentIds.map(String));
    setDismissed((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([id, decision]) => !(decision === "accepted" && drop.has(id))),
      ),
    );
    if (ref) await deps.clearAcceptedDecisions(ref, commentIds);
  };

  const reset = () => setDismissed({});

  return { dismissed, setDecision, clearAccepted, reset };
}
