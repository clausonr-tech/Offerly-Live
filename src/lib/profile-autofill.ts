/**
 * Filling in a student's empty profile fields from their resume and LinkedIn.
 *
 * Replaces the LinkedIn data-export box, which asked the student to download
 * their own LinkedIn archive and upload a CSV to get their name back.
 *
 * Only ever fills a field that is EMPTY - anything the student typed stands.
 * Two sources, in order of authority:
 *
 *   - The resume, read on upload (lib/resume-profile). Free. Its degree line
 *     is the official record: "BS in Economics, Concentration in Finance".
 *   - LinkedIn, looked up once when the student saves the link. One provider
 *     credit (about $0.30), and only when there is still something to fill.
 *     Their "About" section is their own words, which is what About me is for.
 *
 * The parsers are pure and exported for tests; the two fill functions do the
 * reading and writing and never throw - autofill must not fail an upload or a
 * saved link.
 */

import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { findBlockedLanguage } from "@/lib/content-limits";
import { fetchLinkedInProfile, type LinkedInProfile } from "@/lib/crustdata-client";
import { rateLimit } from "@/lib/rate-limit";
import { sameSchool } from "@/lib/school-name";

/** users.about_me's limit (lib/validation). */
export const ABOUT_ME_MAX = 600;

// The LinkedIn fill is a paid provider credit (~$0.30). Saving or correcting a
// link is a once-or-twice action, but the only prior guard was "a field is
// empty" - a state the student controls, so alternating the link while About
// me/major stay blank could burn credits without bound. Cap the paid lookups
// per account per day; over the cap the fill is skipped silently (the link
// still saves and nothing fails), so the feature is unchanged for real use.
const ENRICH_LIMIT = 3;
const ENRICH_WINDOW_MS = 24 * 60 * 60_000;

const DEGREE = String.raw`(?:B\.?\s?S\.?(?:E\.?)?|B\.?\s?A\.?|B\.?B\.?A\.?|A\.?B\.?|Bachelor(?:'s)?(?:\s+of\s+[A-Za-z ]+?)?|Major(?:ing)?)`;

/**
 * The major on a resume's degree line, or null.
 *
 * Reads the EDUCATION lines of the stored summary: "BS in Economics,
 * Concentrations in Finance and TBD" -> "Economics (Finance concentration)".
 * A concentration marked TBD or undecided is left out rather than guessed.
 */
export function majorFromResume(resumeText: string | null | undefined): string | null {
  if (!resumeText) return null;
  const education = resumeText.split(/\n(?=[A-Z][A-Z ]+\n)/)[0] ?? "";
  if (!/^EDUCATION/m.test(education)) return null;
  for (const line of education.split("\n")) {
    const degree = line.match(new RegExp(`\\b${DEGREE}\\s*(?:in|:|-)\\s*([^,;|·(]+)`, "i"));
    if (!degree) continue;
    const major = degree[1].trim().replace(/\s+/g, " ").replace(/\.$/, "");
    if (!major || major.length > 60) continue;
    const conc = line.match(/Concentrations?\s+in\s+([^;|·(]+)/i)?.[1] ?? "";
    const concentrations = conc
      .split(/,|\band\b|&/i)
      .map((c) => c.trim())
      .filter((c) => c && !/^(tbd|undecided|n\/?a)$/i.test(c));
    return concentrations.length ? `${major} (${concentrations.join(" and ")} concentration)` : major;
  }
  return null;
}

/**
 * The field of study LinkedIn lists for the student's own school - not their
 * high school's, not an exchange semester's. Null when no entry matches.
 */
export function majorFromLinkedIn(profile: LinkedInProfile, school: string | null): string | null {
  const own = profile.education.filter((e) => e.fieldOfStudy && (!school || sameSchool(school, e.school)));
  // The one with the latest end year is the current degree.
  const current = own.sort((a, b) => (b.endYear ?? 0) - (a.endYear ?? 0))[0];
  return current?.fieldOfStudy?.replace(/\s+/g, " ").trim() || null;
}

/**
 * About me from LinkedIn: their own "About" text, cut at a sentence end to fit
 * the field; their headline when there is no About section.
 */
export function aboutFromLinkedIn(profile: LinkedInProfile): string | null {
  const text = (profile.summary ?? "").replace(/\s+/g, " ").trim();
  if (text) {
    if (text.length <= ABOUT_ME_MAX) return text;
    const cut = text.slice(0, ABOUT_ME_MAX);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    return end > 80 ? cut.slice(0, end + 1) : `${cut.slice(0, ABOUT_ME_MAX - 1).replace(/\s+\S*$/, "")}…`;
  }
  return profile.headline?.trim() || null;
}

/** users.major's limit on the Account tab (lib/validation). */
const MAJOR_MAX = 200;

/**
 * A value this module is about to store in a column other people read.
 *
 * users.about_me and users.major are shown on the public profile, in the
 * student directory and in the firms' matching options, so the project's rule
 * is that they carry the blocked-language check (CLAUDE.md; updateAccount runs
 * it on the same two columns when a student types them). These values are NOT
 * typed by the student: they come from a third-party provider's profile text
 * or from a model's reading of a resume, and the LinkedIn URL is only
 * host-checked, never proved to be the student's own - so the text can be
 * whatever is on the profile they pointed at. A value that fails the check is
 * dropped rather than refused: nothing here is a form the student can correct,
 * and autofill is allowed to fill nothing.
 */
function storable(value: string | null, max: number): string | null {
  if (!value) return null;
  const clipped = value.length > max ? value.slice(0, max) : value;
  return findBlockedLanguage(clipped) ? null : clipped;
}

/** What a fill changed, for the caller to report. */
export type Filled = { major?: string; aboutMe?: string };

/** After a resume is read: fill an empty major from its degree line. Free. */
export async function fillEmptyProfileFromResume(userId: string): Promise<Filled> {
  try {
    const db = await getDb();
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { major: true, resumeText: true },
    });
    if (!user || user.major?.trim()) return {};
    const major = storable(majorFromResume(user.resumeText), MAJOR_MAX);
    if (!major) return {};
    await db.update(users).set({ major }).where(eq(users.id, userId));
    return { major };
  } catch {
    return {};
  }
}

/**
 * After a LinkedIn link is saved: fill empty About me and major from it.
 * Pays for the lookup only when one of them is actually empty.
 */
export async function fillEmptyProfileFromLinkedIn(userId: string, profileUrl: string): Promise<Filled> {
  try {
    const db = await getDb();
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { major: true, aboutMe: true, school: true },
    });
    if (!user) return {};
    const needMajor = !user.major?.trim();
    const needAbout = !user.aboutMe?.trim();
    if (!needMajor && !needAbout) return {};

    // Bound the paid lookups per account; skip silently over the cap.
    const gate = await rateLimit("crustdata:enrich", userId, ENRICH_LIMIT, ENRICH_WINDOW_MS);
    if (!gate.allowed) return {};

    const { profile } = await fetchLinkedInProfile(profileUrl);
    if (!profile) return {};

    const filled: Filled = {};
    if (needMajor) {
      const major = storable(majorFromLinkedIn(profile, user.school), MAJOR_MAX);
      if (major) filled.major = major;
    }
    if (needAbout) {
      const aboutMe = storable(aboutFromLinkedIn(profile), ABOUT_ME_MAX);
      if (aboutMe) filled.aboutMe = aboutMe;
    }
    if (filled.major || filled.aboutMe) {
      await db.update(users).set(filled).where(eq(users.id, userId));
    }
    return filled;
  } catch {
    return {};
  }
}
