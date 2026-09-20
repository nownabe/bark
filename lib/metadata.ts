// Shape of the comment metadata the review UI works with.
//
// The wire format lives in `lib/pr/metadata.ts` (the Executor writes v2 and
// reads v1/v2); `adapters/commentViewsToExisting.ts` restores this shape from
// a CommentView. These are the types only — nothing here encodes or decodes.

/** Range in the source (start/end line・col). */
export interface AnchorRange {
  sl: number;
  sc: number;
  el: number;
  ec: number;
}

/** Structured metadata attached to a comment. */
export interface CommentMetadata {
  /** comment id (local uuid). */
  cid: string;
  path: string;
  range: AnchorRange;
  /** quoted text used for re-anchoring. */
  quote: string;
  /** which source revision the comment was made against (createdAtSha). */
  sha: string;
  /** conversation grouping (threadId). */
  thread: string;
  /** comment | suggestion. Treated as comment when omitted. */
  kind?: "comment" | "suggestion";
}
