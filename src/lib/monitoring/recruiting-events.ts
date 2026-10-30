import "server-only";
import type { NormalizedListing } from "./connectors/types";

/**
 * Recruiting events, read out of the rows the classifier rejects.
 *
 * Evercore's board publishes "2028 Summer Analyst Intro to Evercore - Duke"
 * and "2028 Evercore Summer Analyst Chicago - Industrials Coffee Chats"
 * alongside its real vacancies. They read exactly like internships, they are
 * not, and rejecting them was correct - a student shown a coffee chat as an
 * opening has been misled.
 *
 * Throwing them away was not correct. A coffee chat with Evercore is worth a
 * great deal to a student; it is simply a different kind of thing, and it
 * belongs in a different table with different fields.
 *
 * Everything here is EXTRACTED, never inferred. An event with no parseable
 * date is stored with a null date rather than a guessed one - a student plans
 * around these, and a wrong time is worse than a link they have to open.
 */

export type RecruitingEventKind =
  | "info_session"
  | "coffee_chat"
  | "networking"
  | "insight_day"
  // Never read from a title by the parser below; set only by a firm posting
  // its own event on the firm portal.
  | "speaker_event"
  | "other";

export type ParsedRecruitingEvent = {
  kind: RecruitingEventKind;
  eventDate: Date | null;
  registrationDeadline: Date | null;
  school: string | null;
  /** The text the dates were read out of, so a wrong one is checkable. */
  evidence: string | null;
};

const KIND_PATTERNS: [RegExp, RecruitingEventKind][] = [
  [/\binfo(rmation)?\s+sessions?\b/i, "info_session"],
  [/\bcoffee\s+chats?\b/i, "coffee_chat"],
  [/\b(networking|reception|meet[- ]the[- ]|mixer)\b/i, "networking"],
  [/\binsight\s+(days?|evenings?)\b/i, "insight_day"],
  [/\bintro(duction)?\s+to\b/i, "info_session"],
  /**
   * Plurals, and both spellings of the commonest one.
   *
   * These were written singular and American: `career\s+fair` misses the
   * British "Careers Fair", and nothing here matched "Insight Days", "Open
   * Days", "Webinars" or "Panels". A board that pluralises its own event
   * titles - most of them do, because they run several - had every one read
   * as the neutral "other".
   *
   * The same class of bug as the singular "Coffee Chat" that missed
   * Evercore's "Coffee Chats", which this file already records.
   */
  [/\b(open\s+(days?|houses?)|careers?\s+fairs?)\b/i, "info_session"],
  [/\b(webinars?|panels?|firesides?|panel\s+discussions?)\b/i, "info_session"],
  [/\b(roadshows?|careers?\s+forums?|symposi(um|a))\b/i, "info_session"],
];

/**
 * The same question, asked of the description when the title cannot answer it.
 *
 * Measured, not guessed: of the 29 events filed by September 2026, 26 read as
 * the neutral "other" because their titles name a brand rather than a format -
 * "The Power to Move Markets", "EMEA | Chester Firmwide Recruitment Event".
 * "Recruitment event" says it is an event, which is the one thing already
 * known. Adding a title rule for it would name no kind, and a rule for "The
 * Power to" would encode one bank's marketing campaign for one season.
 *
 * The format is in the description, stated plainly and by the source itself:
 * "In this session, you'll explore...", "During this interactive panel",
 * "an exclusive virtual session to learn more about our businesses". That is
 * extraction, the same standard the dates are held to - so these patterns are
 * deliberately phrases a source uses to describe its own format, never
 * inferences from topic or audience.
 *
 * Kept below the title rules, because a title that names its format outright
 * is the stronger signal and should not be overridden by stray prose.
 */
const DESCRIPTION_KIND_PATTERNS: [RegExp, RecruitingEventKind][] = [
  [/\bcoffee\s+chats?\b/i, "coffee_chat"],
  [/\binsight\s+(day|evening)\b/i, "insight_day"],
  [/\bnetworking\s+(reception|event|session)\b/i, "networking"],
  [/\b(drinks\s+reception|networking\s+opportunit)/i, "networking"],
  [/\bmeet\s+(with\s+)?(our|the)\s+(people|team|teams|professionals|bankers|recruiters)\b/i, "networking"],
  [/\bget\s+to\s+know\s+(our|the)\s+(team|teams|people)\b/i, "networking"],
  [/\binfo(rmation)?\s+sessions?\b/i, "info_session"],
  [/\b(interactive|virtual|this|the)\s+(panel|session)\b/i, "info_session"],
  [/\b(session|panel|webinar)\s+(will|offers|introduces?)\b/i, "info_session"],
  [/\byou[’']?ll\s+(hear|learn|explore|gain)\b/i, "info_session"],
  [/\bhear\s+(directly\s+)?from\b/i, "info_session"],
];

/** The phrase a kind was read out of, so a wrong badge is checkable against
 *  the source text rather than taken on trust. */
function matchKind(
  text: string,
  patterns: [RegExp, RecruitingEventKind][],
): { kind: RecruitingEventKind; evidence: string } | null {
  for (const [pattern, kind] of patterns) {
    const m = pattern.exec(text);
    if (m) {
      // A little of the surrounding sentence, so the quote can be found in the
      // source by eye rather than hunting for a bare word.
      const start = Math.max(0, m.index - 30);
      return { kind, evidence: text.slice(start, m.index + m[0].length + 40).replace(/\s+/g, " ").trim() };
    }
  }
  return null;
}

/**
 * Universities named in an event title.
 *
 * Campus events name their school after a dash - "Intro to Evercore - Duke",
 * "Info Session - University of Southern California". Matched on a list rather
 * than "whatever follows the dash", because plenty of titles end in a city or
 * a desk and calling New York a university would be worse than leaving it null.
 */
const SCHOOL_HINTS =
  /\b(universit(y|ies)|college|school of|institute of technology|\b(harvard|wharton|penn|yale|princeton|stanford|duke|cornell|columbia|dartmouth|brown|mit|nyu|georgetown|michigan|berkeley|ucla|usc|uchicago|northwestern|notre dame|vanderbilt|emory|rice|texas|virginia|unc|indiana|villanova|boston college|bentley|baruch|rutgers|mcgill|lse|oxford|cambridge|warwick|imperial)\b)/i;

/**
 * Dates as these feeds write them.
 *
 * TalentLink emits "Event Date:29 Oct 2026 06:00 PM PDT" and "Registration
 * Deadline:29 Oct 2026 11:55 PM EST" - the same structured labels that tell
 * the classifier this row is an event rather than a vacancy.
 */
/**
 * Both date orders, because both are in the corpus.
 *
 * This read only `14 March 2027` - day first, the UK and European order. Every
 * US board writes `March 14, 2027`, and this product's students are applying
 * to US firms: Goldman, JPMorgan and Morgan Stanley all publish their event
 * dates month-first. A US info session therefore parsed to a null date and
 * was filed as an event nobody could be told the date of.
 *
 * The comma is optional because boards are inconsistent about it, and the
 * time suffix stays attached to whichever order matched.
 */
const DAY_FIRST = String.raw`\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}`;
const MONTH_FIRST = String.raw`[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}`;
const CLOCK = String.raw`(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?`;

function parseLabelledDate(text: string, label: RegExp): { date: Date; evidence: string } | null {
  const m = new RegExp(
    label.source + String.raw`\s*:?\s*((?:${DAY_FIRST}|${MONTH_FIRST})${CLOCK})`,
    "i",
  ).exec(text);
  if (!m) return null;
  // Timezone abbreviations are deliberately dropped rather than mapped: Date
  // parses the date and time correctly without them, and a wrong offset would
  // silently move an event by hours.
  const parsed = new Date(m[1].replace(/\s+/g, " "));
  if (Number.isNaN(parsed.getTime())) return null;
  return { date: parsed, evidence: m[0].trim().slice(0, 160) };
}

export function parseRecruitingEvent(listing: NormalizedListing): ParsedRecruitingEvent {
  const haystack = `${listing.title} ${listing.descriptionRaw}`;

  // Title first, description second, "other" when neither says. Never the
  // topic or the audience: a session about Global Markets is not an
  // "insight day" because it mentions insight.
  const matched =
    matchKind(listing.title, KIND_PATTERNS) ??
    matchKind(listing.descriptionRaw ?? "", DESCRIPTION_KIND_PATTERNS);
  const kind = matched?.kind ?? "other";

  const event = parseLabelledDate(haystack, /event\s+date/i);
  const registration = parseLabelledDate(haystack, /registration\s+deadline/i);

  // The school, when the title names one after a separator.
  let school: string | null = null;
  const tail = /[-–—]\s*([^-–—]{3,70})\s*$/.exec(listing.title)?.[1]?.trim();
  if (tail && SCHOOL_HINTS.test(tail)) school = tail;

  return {
    kind,
    eventDate: event?.date ?? null,
    registrationDeadline: registration?.date ?? null,
    school,
    evidence:
      [event?.evidence, registration?.evidence, matched?.evidence].filter(Boolean).join(" · ") ||
      null,
  };
}

/**
 * Should a rejected listing be kept as a recruiting event?
 *
 * Two ways to qualify, and the second was missing.
 *
 * 1. The classifier said so. That happens when the SOURCE labels the row an
 *    event - TalentLink emits "Event Date:" and "Registration Deadline:" - so
 *    reading the classifier's own words keeps the two from drifting apart.
 *
 * 2. The TITLE says so. This is the gap: the label check only ever fires on
 *    boards that publish structured event fields, so an info session on any
 *    other board was rejected as "not an internship" and thrown away.
 *    Measured 19 September 2026 - three Merrill "Campus Recruiting
 *    Information Session" rows were dropped exactly that way, while BofA's
 *    TalentLink events beside them were kept.
 *
 * The title test reuses KIND_PATTERNS rather than a second list, so a format
 * this file can already name is a format it will also keep. It is deliberately
 * narrower than the description-based fallback used for KIND: a description
 * mentioning "in this session" is fine for labelling something already known
 * to be an event, and nowhere near enough to reclassify a rejected job posting
 * as one.
 */
export function wasRejectedAsEvent(matchedEvidence: string[], title?: string): boolean {
  if (matchedEvidence.some((e) => /recruiting event|labels this an event/i.test(e))) return true;
  if (!title) return false;

  /**
   * A job that ORGANISES events is still a job.
   *
   * "Private Capital Advisory Roadshow Coordinator" is a role at Piper
   * Sandler, and it matched the roadshow pattern on the first pass. Titles
   * naming a person rather than an occasion are excluded before the format
   * patterns get a look.
   */
  const format = KIND_PATTERNS.map(([p]) => p.exec(title)?.index)
    .filter((i): i is number => i !== undefined)
    .sort((a, b) => a - b)[0];
  if (format === undefined) return false;

  /**
   * Is the role word the JOB, or the AUDIENCE?
   *
   * The guard used to refuse any title containing a role word, and that threw
   * away the commonest event titles there are: "2028 Summer Analyst Evercore
   * Networking Reception", "Summer Analyst Symposium", "Analyst Insight
   * Evening". Every one names the audience it is FOR, and every one was
   * discarded as a job posting.
   *
   * Position tells them apart. In a job title the role is the head noun and
   * comes last - "Roadshow Coordinator", "Events Manager". In an event title
   * the role is the audience and comes before the format - "Summer Analyst
   * Symposium". So compare where they sit: a role word after the format word
   * is somebody's job; one before it is who the event is for.
   *
   * The LAST role word, not the first, so "Analyst Roadshow Coordinator"
   * reads as the job it is.
   */
  const roleWord = /\b(coordinator|manager|specialist|associate|analyst|director|officer|lead|planner)\b/gi;
  let lastRole: number | null = null;
  for (const match of title.matchAll(roleWord)) lastRole = match.index ?? null;

  if (lastRole !== null && lastRole > format) return false;
  return true;
}
