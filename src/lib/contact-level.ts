/** Seniority from the title, most senior match first ("Vice President" is
 *  not an "Associate", "Associate Director" is a director). */
export const LEVELS = ["Intern", "Analyst", "Associate", "VP", "Director", "MD / Exec", "Other"] as const;
export function levelOf(role: string | null): (typeof LEVELS)[number] {
  const r = (role ?? "").toLowerCase();
  // "Vice President" must not read as "President" - see the lookbehind.
  if (/managing director|\bmd\b|\bpartner\b|\bceo\b|\bchief\b|founder|(?<!vice[ -])president/.test(r)) return "MD / Exec";
  if (/director|principal|\bhead of\b/.test(r)) return "Director";
  if (/vice president|\bvp\b|\bsvp\b/.test(r)) return "VP";
  if (/associate/.test(r)) return "Associate";
  if (/analyst/.test(r)) return "Analyst";
  if (/intern/.test(r)) return "Intern";
  return "Other";
}
