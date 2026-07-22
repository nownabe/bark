// Visibility-change refresh trigger (ADR 0005 §1): when the tab returns to
// visible after being hidden for at least the threshold, run a full
// RemoteState refresh. Brief tab switches stay silent; "come back tomorrow"
// returns refetch. Periodic polling is intentionally excluded (ADR 0005).

import { useEffect } from "react";

/** 30 s: avoids refetching on quick tab flips while still refreshing for
 *  long absences. Tunable per ADR 0005 (revisit if too eager / too lazy). */
export const VISIBILITY_THRESHOLD_MS = 30_000;

/** Pass `null` while the refresh function is not available yet (bootstrap
 *  in flight / no PR loaded); the listener then does nothing. */
export function useVisibilityRefresh(onRefresh: (() => Promise<void>) | null): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    let hiddenAt = 0;
    const handle = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
      } else if (document.visibilityState === "visible" && hiddenAt > 0) {
        if (Date.now() - hiddenAt >= VISIBILITY_THRESHOLD_MS) {
          void onRefresh?.();
        }
        hiddenAt = 0;
      }
    };
    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, [onRefresh]);
}
