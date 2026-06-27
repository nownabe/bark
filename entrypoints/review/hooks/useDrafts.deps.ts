// Production wiring for useDrafts. Same shape as useAuthFlow.deps.ts —
// the lib/drafts module pulls in wxt/browser-flavoured IndexedDB code,
// which throws when loaded outside an extension runtime.

import { listDrafts, saveDrafts } from "../../../lib/drafts";
import type { DraftsDeps } from "./useDrafts";

export const productionDraftsDeps: DraftsDeps = {
  listDrafts,
  saveDrafts,
};
