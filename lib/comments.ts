// Comment shape consumed by the legacy review UI. Sourced now from the new
// data layer's commentViews via `entrypoints/review/adapters/
// commentViewsToExisting.ts`; the original normaliser + read-after-write
// poller were retired in L7c (Repository.submitDrafts updates LocalState
// directly, so commentViews reflects just-submitted items without an extra
// fetch).
import type { CommentMetadata } from "./metadata";

export interface ExistingComment {
  id: number;
  source: "review" | "issue";
  author: string;
  /** Visible body with metadata stripped. */
  body: string;
  /** The restored anchor for tool-authored comments, null for foreign ones. */
  meta: CommentMetadata | null;
  /** For degraded mode: GitHub-native path/line (review comments only). */
  path?: string;
  line?: number;
}
