// Comment shape the review UI renders. Built from the data layer's
// commentViews by `entrypoints/review/adapters/commentViewsToExisting.ts`.
import type { CommentMetadata } from "./metadata";

export interface ExistingComment {
  id: number;
  source: "review" | "issue";
  author: string;
  /** Visible body with metadata stripped. */
  body: string;
  /** The restored anchor for tool-authored comments, null for foreign ones. */
  meta: CommentMetadata | null;
  /** The data layer's Comment.threadId (== the Thread entity's id). Lets
   *  foreign comments — which have no metadata — group by their real GitHub
   *  thread in the sidebar instead of one thread per comment. */
  threadKey?: string;
  /** For degraded mode: GitHub-native path/line (review comments only). */
  path?: string;
  line?: number;
}
