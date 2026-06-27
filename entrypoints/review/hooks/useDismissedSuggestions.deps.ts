import { listDismissedSuggestions, saveDismissedSuggestions } from "../../../lib/drafts";
import type { DismissedDeps } from "./useDismissedSuggestions";

export const productionDismissedDeps: DismissedDeps = {
  listDismissedSuggestions,
  saveDismissedSuggestions,
};
