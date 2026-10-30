import { CATEGORY_LABELS } from "./firm-metadata";
import { QUIZ_SPECIALTIES } from "./question-bank/specialties";
import { QUIZ_CATEGORIES } from "./question-bank/types";

// The specialties inside each sector, as onboarding and the profile's Interests
// page offer them ("Which product or coverage group are you targeting?").
//
// One list for the whole site: the same specialties the Interview Prep
// dropdown and the question bank use (question-bank/specialties), so a student
// who picks Restructuring here finds Restructuring there. Every one of the 14
// sectors has its own group - Fintech, Insurance and Commercial Banking used to
// sit inside Other Finance, and are sectors in their own right everywhere else.
//
// `group` is the sector's display label from firm-metadata, because onboarding
// and the Interests page match a group to the sector the student picked by that
// label.
export const NICHE_SECTOR_GROUPS: { group: string; sectors: string[] }[] = QUIZ_CATEGORIES.map((category) => ({
  group: CATEGORY_LABELS[category],
  sectors: [...QUIZ_SPECIALTIES[category]],
}));
