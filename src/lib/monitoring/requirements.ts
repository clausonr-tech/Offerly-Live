import "server-only";

/**
 * The requirements section of a job description, pulled out on its own.
 *
 * Kept separate from the full description because it is what a student
 * actually needs to read - GPA, class year, degree, visa status, deadline -
 * and it sits underneath several hundred words of firm boilerplate in almost
 * every posting. It is also where `eligibility.ts` finds its best evidence, so
 * isolating it makes that read more accurate and much cheaper.
 *
 * Deliberately extraction, not summarisation. The text returned is the
 * employer's own, verbatim, so a student reading it is reading the firm rather
 * than our paraphrase of it - and nothing here can invent a requirement that
 * was not on the page.
 */

/** Headings that introduce a requirements block, in the wording these firms
 *  actually use. Ordered by how unambiguous they are. */
const HEADINGS = [
  /**
   * Added 20 September 2026, counted in the corpus rather than guessed.
   *
   * The file's rule is "from real boards, not from imagination", so these
   * were found by asking the stored descriptions which headings they actually
   * use and which of those this list could not see:
   *
   *     58 listings   "what you bring:"
   *      5 listings   "who you are:"
   *      2 listings   "desired qualifications:"
   *      1 listing    "the ideal candidate:"
   *      1 listing    "ideal candidate:"
   *
   * 67 postings whose requirements section was invisible. That is not a
   * cosmetic loss: `readEligibility` reads the requirements first, because
   * that is where a firm states who may apply, and a posting whose section
   * cannot be found falls back to scanning the whole body - where a graduation
   * year is likelier to be boilerplate than a rule.
   *
   * Ordered longest-first within each family, like the existing entries, so
   * "the ideal candidate" is not shadowed by "ideal candidate".
   */
  "what you bring",
  "who you are",
  "the ideal candidate",
  "ideal candidate",
  "desired qualifications",
  "basic qualifications",
  "minimum qualifications",
  "preferred qualifications",
  "qualifications",
  "requirements",
  "required skills",
  "what we look for",
  "what we're looking for",
  "what we are looking for",
  "who we're looking for",
  "who should apply",
  "eligibility",
  "eligibility criteria",
  "skills and experience",
  "experience required",
  "your profile",
  "about you",
  "candidate profile",
  /**
   * Added 19 Sep from real boards, not from imagination.
   *
   * "skills and competencies" is the heading Stockbridge's Dayforce postings
   * actually use - measured live - and the list already carried "skills and
   * experience", so the section was being missed on a technicality. "what
   * you'll need" and its variants are among the commonest headings there are
   * and were simply absent.
   *
   * A missed heading is not a cosmetic loss: requirementsRaw is what a student
   * reads before spending an evening on an application, and null means they
   * are shown nothing.
   */
  "skills and competencies",
  "skills & competencies",
  "what you'll need",
  "what you will need",
  "what you bring",
  "your qualifications",
];

/** Headings that mark the END of the requirements block - anything after one
 *  of these is benefits, legal boilerplate or application mechanics. */
const TERMINATORS = [
  "equal opportunity",
  "equal employment",
  "about the firm",
  "about us",
  "about the company",
  "benefits",
  "what we offer",
  "our commitment",
  "diversity",
  "accommodation",
  "privacy",
  "how to apply",
  "application process",
  "note to recruitment agencies",
  "disclaimer",
  /**
   * Compensation sections, added 19 Sep.
   *
   * Stockbridge's real posting runs "Skills and Competencies:" straight into
   * "Compensation: The base pay scale for this position is $125,000 to
   * $145,000 annually", and without a terminator the pay paragraph was being
   * stored as part of the requirements - so a student reading "what I need to
   * apply" got a salary band and a benefits list.
   *
   * Deliberately narrow. "the firm" and "travel" are also headings on that
   * same posting and are NOT here, because both are phrases a genuine
   * requirements line can contain ("experience at a firm of this size"), and
   * a terminator that fires early truncates the thing it is protecting.
   */
  "compensation",
  "base pay",
  "pay range",
  "salary range",
];

const MAX_REQUIREMENTS = 2500;

function indexOfFirst(haystack: string, needles: string[], from = 0): { index: number; match: string } | null {
  let best: { index: number; match: string } | null = null;
  for (const n of needles) {
    const i = haystack.indexOf(n, from);
    if (i !== -1 && (best === null || i < best.index)) best = { index: i, match: n };
  }
  return best;
}

/**
 * The requirements text, or null when the posting has no identifiable section.
 *
 * Null is a real answer and must not be filled in with the whole description:
 * a posting that never states its requirements has not stated them, and
 * showing a student the firm's mission statement under a "Requirements"
 * heading would be our error presented as theirs.
 */
export function extractRequirements(description: string): string | null {
  if (!description) return null;
  const text = description.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();

  const start = indexOfFirst(lower, HEADINGS);
  if (!start) return null;

  // Begin after the heading itself, and skip any colon or dash that followed it.
  const bodyStart = start.index + start.match.length;
  const end = indexOfFirst(lower, TERMINATORS, bodyStart);

  const slice = text
    .slice(bodyStart, end ? end.index : bodyStart + MAX_REQUIREMENTS)
    .replace(/^[\s:–—-]+/, "")
    .trim();

  // Too short to be a requirements section - usually the phrase appeared in
  // passing ("...meets the requirements of the role...") rather than as a
  // heading.
  if (slice.length < 40) return null;

  return slice.slice(0, MAX_REQUIREMENTS);
}

/**
 * Individual requirement lines, when the section is written as a list.
 *
 * Most ATS descriptions arrive with their markup stripped, so bullets survive
 * as "•", "-" or as sentence breaks. Returns an empty array rather than
 * guessing when the section is a single prose paragraph.
 */
export function splitRequirements(section: string | null): string[] {
  if (!section) return [];
  const parts = section
    .split(/(?:•|·|●|▪|•|\s[-–—]\s|(?<=[a-z)])\.\s+(?=[A-Z]))/)
    .map((s) => s.replace(/^[\s:–—-]+/, "").trim())
    .filter((s) => s.length >= 15 && s.length <= 400);
  return parts.slice(0, 20);
}
