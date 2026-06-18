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
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        {/* speech bubble with a tail */}
        <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v5A1.5 1.5 0 0 1 12.5 10H6.5l-3 2.5V10H3.5A1.5 1.5 0 0 1 2 8.5v-5Z" />
        {/* plus inside */}
        <path d="M8 4.3v3.4M6.3 6h3.4" />
      </svg>
    </button>
  );
}
