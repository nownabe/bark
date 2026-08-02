// Snackbar — global user-facing error / warning surface.
// Per ADR 0005 §4 and design-principle.md §3, every refresh / sync / fetch failure
// is announced via this Snackbar; components may additionally reflect
// errors inline where context helps.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

export type SnackbarSeverity = "error" | "warning";

type SnackbarMessage = {
  id: string;
  message: string;
  severity: SnackbarSeverity;
};

export type SnackbarContextValue = {
  show(message: string, severity?: SnackbarSeverity): void;
};

const SnackbarContext = createContext<SnackbarContextValue | null>(null);

const DEFAULT_DURATION_MS = 5000;

export function SnackbarProvider({
  children,
  durationMs = DEFAULT_DURATION_MS,
}: {
  children: ReactNode;
  durationMs?: number;
}) {
  const [items, setItems] = useState<SnackbarMessage[]>([]);
  const idRef = useRef(0);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setItems((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const show = useCallback<SnackbarContextValue["show"]>(
    (message, severity = "error") => {
      const id = `snack-${++idRef.current}`;
      setItems((prev) => [...prev, { id, message, severity }]);
      const t = setTimeout(() => dismiss(id), durationMs);
      timers.current.set(id, t);
    },
    [dismiss, durationMs],
  );

  // Clear any pending timers on unmount so test runs and live unmounts
  // do not leak timers into the next render.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  return (
    <SnackbarContext.Provider value={{ show }}>
      {children}
      <SnackbarStack items={items} onDismiss={dismiss} />
    </SnackbarContext.Provider>
  );
}

export function useSnackbar(): SnackbarContextValue {
  const ctx = useContext(SnackbarContext);
  if (!ctx) {
    throw new Error("useSnackbar requires a <SnackbarProvider /> ancestor");
  }
  return ctx;
}

function SnackbarStack({
  items,
  onDismiss,
}: {
  items: SnackbarMessage[];
  onDismiss: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="snackbar-stack" role="status" aria-live="polite">
      {items.map((m) => (
        <div key={m.id} className={`snackbar snackbar--${m.severity}`}>
          <span className="snackbar__message">{m.message}</span>
          <button
            type="button"
            className="snackbar__close"
            aria-label="Dismiss"
            onClick={() => onDismiss(m.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
