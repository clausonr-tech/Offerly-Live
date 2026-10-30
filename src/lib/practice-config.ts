import {
  PRACTICE_MODES,
  ROUND_DIFFICULTIES,
  type PracticeMode,
  type RoundConfig,
  type RoundDifficulty,
} from "./practice-session";
import { currentSpecialty, isSpecialtyOf } from "./question-bank/specialties";
import { PRACTICE_FORMATS, QUIZ_CATEGORIES, type PracticeFormat, type QuizCategory } from "./question-bank/types";

/** A round's setup as the practice page sends it - untrusted. */
export type RawRoundConfig = {
  mode: string;
  difficulty: string;
  format?: string;
  categories: string[];
  /** Sector -> the specialties picked inside it. */
  specialties?: Record<string, string[]>;
};

/**
 * A round's setup, checked. The config arrives from the browser, so every
 * field is re-validated rather than trusted - an unchecked category would reach
 * a sector enum column. Anything malformed (a missing list, a string where an
 * array belongs, an unknown sector or specialty) is dropped or rejected, never
 * thrown on: a bad request gets "pick a sector", not a server error.
 *
 * Null when the round cannot run: an unknown mode or difficulty, or a
 * technical or mixed round with no valid sector. Nothing picks a sector on the
 * student's behalf.
 */
export function parseRoundConfig(raw: unknown): RoundConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Record<keyof RawRoundConfig, unknown>>;

  if (!PRACTICE_MODES.includes(r.mode as PracticeMode)) return null;
  if (!ROUND_DIFFICULTIES.includes(r.difficulty as RoundDifficulty)) return null;
  const mode = r.mode as PracticeMode;

  const categories = [
    ...new Set(
      (Array.isArray(r.categories) ? r.categories : []).filter((c): c is QuizCategory =>
        QUIZ_CATEGORIES.includes(c as QuizCategory),
      ),
    ),
  ];
  // A technical or mixed round needs at least one sector to draw from.
  if (mode !== "behavioral" && categories.length === 0) return null;

  // Only known specialties of a sector that is actually in the round. They are
  // fixed choices, never free text.
  const rawSpecialties =
    r.specialties && typeof r.specialties === "object" && !Array.isArray(r.specialties)
      ? (r.specialties as Record<string, unknown>)
      : {};
  const specialties: RoundConfig["specialties"] = {};
  for (const category of categories) {
    const list = rawSpecialties[category];
    const picked = [
      ...new Set(
        (Array.isArray(list) ? list : [])
          .filter((s): s is string => typeof s === "string")
          .map(currentSpecialty)
          .filter((s) => isSpecialtyOf(category, s)),
      ),
    ];
    if (picked.length > 0) specialties[category] = picked;
  }

  const format = PRACTICE_FORMATS.includes(r.format as PracticeFormat) ? (r.format as PracticeFormat) : "written";
  return { mode, difficulty: r.difficulty as RoundDifficulty, categories, specialties, format };
}
