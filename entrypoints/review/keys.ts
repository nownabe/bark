// Keyboard helpers for the review surface.

/**
 * The "submit" chord — Ctrl+Enter or Cmd+Enter — used to confirm a reply or
 * comment from the keyboard, mirroring the Add button (not the Review submit).
 */
export function isSubmitChord(e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return (e.metaKey || e.ctrlKey) && e.key === "Enter";
}
