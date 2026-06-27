import { listSuggestionEdits, saveSuggestionEdits } from "../../../lib/drafts";
import type { SuggestionEditsDeps } from "./useSuggestionEdits";

export const productionSuggestionEditsDeps: SuggestionEditsDeps = {
  listSuggestionEdits,
  saveSuggestionEdits,
};
