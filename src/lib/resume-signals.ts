/**
 * Reading structured signals back out of a stored resume summary.
 *
 * The resume IS parsed properly on upload - `summarySchema` in resume-profile
 * pulls education, experience, activities, skills and interests - but the
 * result is flattened into one labelled string in `users.resumeText` and the
 * structure is thrown away. So a student whose resume lists their interests
 * has them on file and unreachable: nothing reads them, and the onboarding
 * `interests` field stays empty unless they type it all again.
 *
 * This reads them back. The format is ours and deterministic (see
 * formatSummary), so parsing it is reliable rather than a guess at free prose.
 *
 * The honest alternative is storing the parsed object alongside the text, which
 * is a schema change; this needs none and can be replaced by that later without
 * changing any caller.
 */

export type ResumeSignals = {
  /** Hobbies and interests, as listed. */
  interests: string[];
  /** Skills, as listed. */
  skills: string[];
  /** Organisations the student has worked for, most recent first. */
  employers: string[];
  /** Clubs and societies. */
  activities: string[];
};

const EMPTY: ResumeSignals = { interests: [], skills: [], employers: [], activities: [] };

/** The lines under one LABELLED heading, up to the next heading. */
function section(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return [];

  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // Headings are bare uppercase words; entries start with "- ".
    if (/^[A-Z][A-Z &]+$/.test(line.trim())) break;
    out.push(line);
  }
  return out;
}

/** "- a, b, c" -> ["a", "b", "c"] */
function commaList(lines: string[]): string[] {
  return lines
    .filter((l) => l.trim().startsWith("- "))
    .flatMap((l) => l.trim().slice(2).split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

/** "- Evercore · Summer Analyst · New York · 2025" -> "Evercore" */
function leadingNames(lines: string[]): string[] {
  return lines
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).split("·")[0].trim())
    .filter(Boolean);
}

export function resumeSignals(resumeText: string | null | undefined): ResumeSignals {
  const text = (resumeText ?? "").trim();
  if (!text) return EMPTY;

  return {
    interests: dedupe(commaList(section(text, "INTERESTS"))),
    skills: dedupe(commaList(section(text, "SKILLS"))),
    employers: dedupe(leadingNames(section(text, "WORK EXPERIENCE"))),
    activities: dedupe(leadingNames(section(text, "CLUBS & ACTIVITIES"))),
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)].slice(0, 12);
}
