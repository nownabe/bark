// Bridge from the data layer's CommentView to the review UI's
// ExistingComment shape, so the render / re-anchoring pipeline consumes
// comments sourced from the Repository's AppState.
//
// One-way only: the data layer is the source of truth, and nothing written
// here flows back into it.

import type { CommentView } from "../../../lib/pr/appstate";
import type { ExistingComment } from "../../../lib/comments";
import type { CommentMetadata } from "../../../lib/metadata";

/** Convert an iterable of CommentView (the values of `AppState.commentViews`)
 *  to the `ExistingComment[]` shape.
 *
 *  - Only synced comments with a known remoteId are included; drafts and
 *    syncing items belong to the pending list, not the submitted list.
 *  - Bark-authored comments restore a full `CommentMetadata` from the
 *    Comment's anchor + threadId + parsed body kind.
 *  - Foreign comments (from `foreign-review-*` / `foreign-issue-*` ids)
 *    surface with `meta=null` and degrade to GitHub-native path/line
 *    (review comments only). */
export function commentViewsToExisting(views: Iterable<CommentView>): ExistingComment[] {
  const out: ExistingComment[] = [];
  for (const view of views) {
    const ec = toExistingComment(view);
    if (ec) out.push(ec);
  }
  return out;
}

function toExistingComment(view: CommentView): ExistingComment | null {
  const c = view.comment;
  if (c.state !== "synced" || c.remoteId === undefined) return null;

  const isForeignIssue = c.id.startsWith("foreign-issue-");
  const isForeignReview = c.id.startsWith("foreign-review-");
  const source: "review" | "issue" = isForeignIssue ? "issue" : "review";

  const meta: CommentMetadata | null =
    isForeignIssue || isForeignReview
      ? null
      : {
          cid: c.id,
          path: c.path,
          range: c.anchor.range,
          quote: c.anchor.quote,
          sha: c.anchor.sha,
          thread: c.threadId,
          kind: view.kind,
        };

  const base: ExistingComment = {
    id: c.remoteId,
    source,
    author: c.author.login,
    body: c.body,
    meta,
    threadKey: c.threadId,
  };
  if (source === "review") {
    base.path = c.path;
    // ExistingComment.line carries the GitHub-native end line (right side).
    // remote-fetcher encodes "no line known" (the comment is outdated /
    // sits outside the diff) as range.el === 0; leave `line` undefined
    // rather than forwarding a 0 the UI would read as a real line.
    if (c.anchor.range.el > 0) base.line = c.anchor.range.el;
  }
  return base;
}
