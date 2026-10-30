// What the practice setup's Industry and Sector boxes say, given what is
// picked. Pure and client-safe (it reads only the label vocabulary), so the
// two boxes' wording can be tested without rendering the page.

import { CATEGORY_LABELS, type QuizCategory } from "./types";

/** "Pick an industry", one or two industries by name, or the first and a count. */
export function industryLabel(categories: readonly QuizCategory[], needsSector: boolean): string {
  if (categories.length === 0) return needsSector ? "Pick an industry" : "Any industry";
  if (categories.length <= 2) return categories.map((c) => CATEGORY_LABELS[c]).join(" + ");
  return `${CATEGORY_LABELS[categories[0]]} +${categories.length - 1} more`;
}

function sectorPart(c: QuizCategory, picked: readonly string[], withIndustry: boolean): string {
  const what = picked.length === 0 ? "All" : picked.length === 1 ? picked[0] : `${picked.length} sectors`;
  if (!withIndustry) return picked.length === 0 ? `All ${CATEGORY_LABELS[c]}` : what;
  return `${CATEGORY_LABELS[c]}: ${what}`;
}

/**
 * The Sector box: nothing to pick until an industry is, then that industry's
 * sectors ("Restructuring", "All Investment Banking"), and with two or more
 * industries, each one's by name ("Investment Banking: Restructuring ·
 * Private Equity: All").
 */
export function sectorLabel(
  categories: readonly QuizCategory[],
  specialties: Partial<Record<QuizCategory, readonly string[]>>,
): string {
  if (categories.length === 0) return "Pick an industry first";
  if (categories.length === 1) return sectorPart(categories[0], specialties[categories[0]] ?? [], false);
  return categories.map((c) => sectorPart(c, specialties[c] ?? [], true)).join(" · ");
}
