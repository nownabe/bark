// Adapter from the UI's PendingDraft shape to the data layer's `Comment`
// (state: "draft"), so a drafted comment reaches LocalState and is picked up
// by `repository.submitDrafts()`.

import type { PendingDraft } from "../../../lib/drafts";
import type { Comment } from "../../../lib/pr/types";

/** Build a draft `Comment` from a `PendingDraft`. The `parentLocalId`
 *  argument is the local id of the thread's root comment when the draft is
 *  a reply; pass `undefined` for a new top-level comment. */
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
