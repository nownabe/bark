// Icon-only round button shown just above a text selection in the editor.
// Selecting text reveals it; clicking it opens the comment composer (wired in
// App.tsx). It renders nothing when there is no active selection position.
import type { BubblePos } from "../cmAnchor";

interface Props {
  pos: BubblePos | null;
  onClick: () => void;
}

export function SelectionBubble({ pos, onClick }: Props) {
  if (!pos) return null;
  return (
    <button
      type="button"
      className="selection-bubble"
      style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
      onClick={onClick}
      aria-label="Comment on selection"
      title="Comment"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
        <path d="M1.75 2.5A1.75 1.75 0 0 0 0 4.25v6.5C0 11.716.784 12.5 1.75 12.5H3v2.19c0 .47.553.72.905.41L7.2 12.5h7.05A1.75 1.75 0 0 0 16 10.75v-6.5A1.75 1.75 0 0 0 14.25 2.5H1.75Z" />
      </svg>
    </button>
  );
}
