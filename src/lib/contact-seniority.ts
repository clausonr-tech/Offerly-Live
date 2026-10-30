/**
 * How senior someone is, read off their title - for showing a student's
 * contacts junior first.
 *
 * The provider filters on seniority but never returns it, so the title is the
 * only thing on the record to go by. Measured: a Harris Williams set came back
 * CTO, Managing Director, Analyst, Associate, VP - ranked by similarity to the
 * student, which put the two people least likely to answer at the top.
 *
 * Coarse on purpose. Banking titles are not a corporate ladder, and the
 * point is only that an analyst is listed before a managing director.
 *
 * Pure: no network, no database.
 */

/** Lowest first. A title nothing matches sits in the middle, beside a VP. */
const LEVELS: [number, RegExp][] = [
  [0, /\b(intern|summer (analyst|associate)|incoming)\b/i],
  // Checked before "analyst"/"associate": a Senior Managing Director is an MD.
  [5, /\b(managing director|md|partner|head of|chief|ceo|cfo|cto|coo|cio|(?<!vice[ -])president|founder|chair(man|woman)?|vice chair|board member|senior advisor)\b/i],
  [4, /\b(principal|director|executive director)\b/i],
  [3, /\b(vice president|vp|svp|avp|manager)\b/i],
  [2, /\b(senior associate|associate)\b/i],
  [1, /\b(analyst)\b/i],
];

const UNKNOWN_LEVEL = 3;

/** 0 (intern) .. 5 (managing director, partner, C-suite). */
export function seniorityLevel(title: string | null | undefined): number {
  const t = (title ?? "").trim();
  if (!t) return UNKNOWN_LEVEL;
  for (const [level, pattern] of LEVELS) if (pattern.test(t)) return level;
  return UNKNOWN_LEVEL;
}

/**
 * Junior first. Stable: people at the same level keep the order they came in
 * (similarity to the student), so the ranking still decides within a level.
 */
export function juniorFirst<T>(items: T[], titleOf: (item: T) => string | null | undefined): T[] {
  return items
    .map((item, index) => ({ item, index, level: seniorityLevel(titleOf(item)) }))
    .sort((a, b) => a.level - b.level || a.index - b.index)
    .map((x) => x.item);
}
