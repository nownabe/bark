// Per-thread interaction state (Pack C / R10).
//
// The legacy App tracked four pieces of state that all sit "between
// the user and a thread row":
//   - replyTo / replyText : which thread's inline reply box is open
//                            and what's typed in it
//   - emphasizedThreadId   : which thread row (or live suggestion) is
//                            currently highlighted in the sidebar / editor
//   - resolvingId          : which thread has a resolve/reopen request
//                            in flight (drives the inline button label)
//
// They are all UI-local and have no IO of their own; this hook
// concentrates the named actions the parent kept inlining
// (start a reply, cancel a reply, drop emphasis) so future surfaces
// can call them by name. The actual GitHub API call for resolve /
// reopen still lives in the parent because it depends on the
// `client` + the per-thread comments map.

import { useState } from "react";

export type ThreadActions = {
  replyTo: string | null;
  replyText: string;
  setReplyText: (text: string) => void;
  /** Open the inline reply box for `threadId` and clear any draft text. */
  startReply: (threadId: string) => void;
  /** Close the reply box and clear draft text. */
  cancelReply: () => void;

  emphasizedThreadId: string | null;
  setEmphasizedThreadId: (id: string | null) => void;
  /** Convenience alias for setEmphasizedThreadId(null). */
  clearEmphasis: () => void;

  /** Thread whose resolve/reopen request is in flight. */
  resolvingId: string | null;
  setResolvingId: (id: string | null) => void;
};

export function useThreadActions(): ThreadActions {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [emphasizedThreadId, setEmphasizedThreadId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const startReply = (threadId: string) => {
    setReplyTo(threadId);
    setReplyText("");
  };
  const cancelReply = () => {
    setReplyTo(null);
    setReplyText("");
  };
  const clearEmphasis = () => setEmphasizedThreadId(null);

  return {
    replyTo,
    replyText,
    setReplyText,
    startReply,
    cancelReply,
    emphasizedThreadId,
    setEmphasizedThreadId,
    clearEmphasis,
    resolvingId,
    setResolvingId,
  };
}
