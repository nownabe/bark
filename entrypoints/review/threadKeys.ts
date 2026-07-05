// Map Repository Thread ids into the reviewItems thread-key space.
//
// The sidebar (reviewItems) keys a thread differently from the data layer:
//   - Bark-authored comments key by their cid, which equals Repository
//     Thread.id.
//   - Foreign comments key by `solo:<source>:<remoteId>` — reviewItems'
//     one-comment-per-thread shape — so one Repository Thread surfaces as
//     one key per foreign comment it contains.
// This helper walks the CommentViews and collects the reviewItems key of
// every comment belonging to one of the given Thread ids, so callers can
// ask "which sidebar threads are resolved / resolvable" without duplicating
// the keying rules.

import type { CommentView } from "../../lib/pr/appstate";

export function threadKeysForThreadIds(
  commentViews: Iterable<CommentView>,
  threadIds: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  if (threadIds.size === 0) return out;
  for (const v of commentViews) {
    if (!threadIds.has(v.comment.threadId)) continue;
    const cid = v.comment.id;
    if (cid.startsWith("foreign-review-")) {
      if (v.comment.remoteId !== undefined) out.add(`solo:review:${v.comment.remoteId}`);
    } else if (cid.startsWith("foreign-issue-")) {
      if (v.comment.remoteId !== undefined) out.add(`solo:issue:${v.comment.remoteId}`);
    } else {
      out.add(cid);
    }
  }
  return out;
}
