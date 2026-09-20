// Author's accept / reject decisions on submitted suggestions
// (Pack B / R8c).
//
// Mirrors the useDrafts shape: a plain map + a restore effect + a single
// "set + persist" action. The id → SuggestionDecision mapping is keyed
// by the submitted comment's REST id (stringified) and is used by the
// review list to hide accepted/rejected suggestions and by submit flows
// to materialise accepted ones into actual commits.

import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import type { SuggestionDecision } from "../../../lib/drafts";
import type { PrRef } from "../../../lib/pr/types";

export type DismissedDeps = {
  listDismissedSuggestions: (ref: PrRef) => Promise<Record<string, SuggestionDecision>>;
  saveDismissedSuggestions: (
    ref: PrRef,
    dismissed: Record<string, SuggestionDecision>,
  ) => Promise<void>;
};

export type DismissedSuggestions = {
  dismissed: Record<string, SuggestionDecision>;
  /** Lower-level escape hatch (used by submit flows that filter accepted
   *  decisions in bulk). Local-only — the parent persists separately via
   *  clearAcceptedDecisions. */
  setDismissed: Dispatch<SetStateAction<Record<string, SuggestionDecision>>>;
  /** Set + persist a single decision atomically. */
  setDecision: (id: number, decision: SuggestionDecision) => Promise<void>;
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

  const reset = () => setDismissed({});

  return { dismissed, setDismissed, setDecision, reset };
}
