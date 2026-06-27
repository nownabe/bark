// Adapter from the legacy PendingDraft shape to the new data layer's
// `Comment` (state: "draft"). Used during L4 to double-write the
// addDraft call site into the Repository so a future repository.submitDrafts()
// (L6) can find the same drafts in LocalState.

import type { PendingDraft } from "../../../lib/drafts";
import type { Comment } from "../../../lib/pr/types";

/** Build a draft `Comment` from a legacy `PendingDraft`. The `parentLocalId`
 *  argument is the local id of the thread's root comment when the draft is
 *  a reply (legacy `addReply`). Pass `undefined` for a new top-level
 *  comment (legacy `addDraft`). */
export function pendingDraftToComment(
  draft: PendingDraft,
  viewerLogin: string,
  parentLocalId?: string,
): Comment {
  return {
    id: draft.cid,
    state: "draft",
    threadId: draft.thread,
    parentLocalId,
    body: draft.body,
    author: { login: viewerLogin },
    path: draft.path,
    anchor: {
      sha: draft.sha,
      range: draft.range,
      quote: draft.quote,
    },
  };
}
