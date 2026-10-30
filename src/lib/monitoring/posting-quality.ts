import "server-only";
import type { NormalizedListing } from "./connectors/types";

/**
 * Is this a real job posting at all?
 *
 * Every rule here comes from something the first live crawl actually
 * published. The classifier was asking "is this a relevant internship?" and
 * never asking "is this a posting?", so anything keyword-shaped on a careers
 * page sailed through:
 *
 *   - Nomura: "Clear Region EMEA (Europe, Middle East and Africa) (22 Results)
 *     AEJ (Asi..." - a filter control on the board's own UI, scraped by the
 *     generic connector because its text contained "intern" further along.
 *   - Deutsche Bank: "Our internship opportunities are your steppingstone to a
 *     career a Deutsc..." - a sentence of marketing copy from the careers page.
 *   - Deutsche Bank: "Internship Programme" - a nav link.
 *
 * All three were AUTO-APPROVED, meaning they were one script away from being
 * shown to students as real openings.
 *
 * The distinction this file draws is deliberately structural, not semantic. It
 * asks whether the thing has the SHAPE of a posting - a title that reads like a
 * role, a body with content, an address of its own - rather than trying to
 * judge the words. Semantic judgement is classify.ts's job, and it can only be
 * trusted once it is being handed real postings.
 */

export type QualityVerdict = {
  ok: boolean;
  /** Why it was refused, quotable in the review queue. Empty when ok. */
  reasons: string[];
  /**
   * True when the listing has the marks of a record from a real system - a
   * stable external id and a body of its own - rather than something recovered
   * from a page's markup. Not a pass/fail on its own; auto-approval requires
   * it, human review does not.
   */
  verifiable: boolean;
};

/** Board furniture: filters, counters, pagination, sort controls. */
const UI_FURNITURE: { pattern: RegExp; reason: string }[] = [
  { pattern: /\(\s*\d+\s+results?\s*\)/i, reason: "contains a result counter - a filter control, not a posting" },
  { pattern: /^\s*(clear|reset|apply|remove)\b.*\bfilters?\b/i, reason: "a filter control" },
  { pattern: /^\s*clear\s+(region|location|category|department|all)\b/i, reason: "a filter-clearing control" },
  { pattern: /\b(show|view|see|load)\s+(more|all|less)\b/i, reason: "a pagination control" },
  { pattern: /^\s*sort\s+by\b/i, reason: "a sort control" },
  { pattern: /^\s*(next|previous|page)\s*\d*\s*$/i, reason: "a pagination control" },
  { pattern: /\bcookie|privacy policy|terms of use|accessibility statement\b/i, reason: "a site-chrome link" },
  { pattern: /^\s*(search|filter|refine)\b\s*$/i, reason: "a search control" },

  /**
   * Breadcrumbs and navigation links, from the generic connector.
   *
   * A connector reading an ordinary careers page has no vacancy table to work
   * from, so it takes the links it can find - and a careers page is mostly
   * links that are not jobs. Measured on Supabase, 20 September 2026, among
   * the listings stuck in the review queue with nothing readable in them:
   *
   *   "Home > Internship Program"            a breadcrumb  (Blaylock Van)
   *   "View internship programmes"  x6       a nav link    (HSBC)
   *   "Contact us about internship opportunities"  -> mailto:  (Bourne)
   *
   * Each one matched an internship phrase, was classified relevant, and went
   * to a human with no description to read, six times over for the same link.
   *
   * The existing "view more/all/less" rule cannot see "View internship
   * programmes", because the pagination shape it was written for puts the
   * quantity word straight after the verb.
   */
  {
    // "Home > X", "Careers › X" - a separator no job title uses.
    pattern: /^[^>›»]{0,40}[>›»]/,
    reason: "a breadcrumb trail, not a role title",
  },
  /**
   * Four more shapes, each measured against all 9,411 distinct stored titles
   * on 11 October 2026. Every one of the 28 titles they match between them is
   * a link, a press release or an article; not one is a job posting.
   *
   * They are here because these rows were reaching the REVIEW QUEUE rather
   * than being rejected - 748 listings were sitting open in it, awaiting a
   * human who, it turned out, had never reviewed a single row in the system's
   * history. The queue was not full of hard calls. It was full of this.
   */
  {
    // "More about internships" (Fidelity), "Learn more about Associate
    // internships". A link to information about jobs, not a job. 7 matched,
    // all links.
    pattern: /^\s*(more|learn more|read more)\s+(about|on)\b/i,
    reason: "a link to information about jobs, not a job",
  },
  {
    // "Careers Internship Corner", "Internship Corner". A section of a
    // website. 2 matched.
    pattern: /\b(corner|hub|resource centre|resource center)\s*$/i,
    reason: "a section of a careers site, not a role",
  },
  {
    // "View internship programmes", "Explore our opportunities", "Find a
    // programme". A verb aimed at the reader, pointing at a list of jobs
    // rather than naming one.
    pattern:
      /^\s*(search|view|browse|explore|discover|find|see)\b[^.]{0,40}\b(programme|program|opportunit|vacanc|role|job|internship)s?\b/i,
    reason: "a link to a list of jobs, not a job",
  },
];

/**
 * Marketing prose, not a job title.
 *
 * The test is grammatical rather than topical: a job title is a noun phrase.
 * It does not address the reader, does not use first person, and does not end
 * in a full stop. "Our internship opportunities are your steppingstone to a
 * career" fails on all three.
 */
const PROSE_MARKERS: { pattern: RegExp; reason: string }[] = [
  /**
   * A press release about the firm's own business.
   *
   * Careers pages and news pages share a template often enough that the
   * generic connector scrapes both. Measured against all 9,411 distinct
   * stored titles: 5 matched, every one a fundraise announcement, and not one
   * contained an internship word at all.
   *
   *   "S2G Investments Closes $1 Billion Solutions Fund I ..."
   *   "Highland Europe raises EUR 1.1B Fund VI ..."
   *   "Quinbrook Closes GBP 587 Million Renewables Impact Fund II ..."
   *
   * The money or the word "fund" is required alongside the verb, because
   * "Analyst, Fund Launches" is a real role and "launches" alone would reject
   * it.
   */
  {
    pattern:
      /\b(closes|announces|launches|raises|completes|acquires|appoints|names)\b.{0,40}(\$|£|€|\bfund\b|\bbillion\b|\bmillion\b)/i,
    reason: "a press release about the firm, not a job posting",
  },
  /**
   * An article ABOUT getting a job, which is not a job.
   *
   * 4 matched across the corpus, three of them carrying an internship word -
   * which is exactly why they reached the review queue and sat there:
   *
   *   "How to Land a Balyasny Internship"
   *   "How to choose the right Fidelity internship focus area for you"
   *   "Why a Fidelity internship drives career growth and how to get an ..."
   *
   * A recruiting event caught by this still reaches the events table:
   * `wasRejectedAsEvent` matches the title against the event formats
   * independently of why the row was rejected.
   */
  {
    pattern: /\b(how to|what to expect|tips for|a guide to|q&a|takeover:)\b/i,
    reason: "an article about applying, not a job posting",
  },
  {
    /**
     * The `at <firm>,` arm had NEVER fired, for two separate reasons.
     *
     * The trailing `\b` was applied to every alternative, including the one
     * ending in a comma - and a comma followed by a space is two non-word
     * characters, so there is no boundary there to match. "At Evercore, our
     * interns..." failed the rule it was written for. The `\b` now belongs to
     * the pronoun arm alone, where it does the job it was meant for (not
     * matching "Ourselves" or "Yourself").
     *
     * And `\w+` only ever reached a single-word firm name, so even with the
     * boundary fixed "At Deutsche Bank," would have slipped through while "At
     * Evercore," did not. Most firms in this directory have multi-word names.
     * Bounded to four words so it stays a sentence opener rather than
     * swallowing a long title that happens to contain a comma.
     *
     * Found by posting-quality.test.ts, which is the first test this file has
     * ever had.
     */
    pattern: /^(?:(?:our|we|you|your)\b|at\s+[\w&.'-]+(?:\s+[\w&.'-]+){0,3},)/i,
    reason: "starts like a sentence of marketing copy, not a role title",
  },
  { pattern: /\b(you'?ll|we'?ll|you can|we are looking|join us|discover|explore our)\b/i, reason: "addresses the reader - marketing copy, not a role title" },
  { pattern: /[.!?]\s*$/, reason: "ends in sentence punctuation - a sentence, not a title" },
  { pattern: /\b(steppingstone|springboard|kickstart your|shape your future)\b/i, reason: "marketing language, not a role title" },
];

/** A title this short or this long is not a role. Bounds chosen from the real
 *  data: "Internship Programme" (20) is a nav link, and every genuine title in
 *  the first crawl sat between roughly 15 and 110 characters. */
const MIN_TITLE = 8;
const MAX_TITLE = 140;

/**
 * Titles that name a programme family rather than an opening.
 *
 * "Internship Programme", "Summer Internships", "Campus Recruiting" are section
 * headings on a careers page. A real posting names a role, a year, a desk or a
 * location alongside the word - which is what the specificity test below looks
 * for.
 */
/**
 * A heading, not an opening.
 *
 * Widened after auditing the corpus: Rothschild's careers site has category
 * pages at /students-and-graduates/apprenticeships and /early-insights, and
 * both were scraped as listings, classified relevant, and would have reached
 * students as openings. Their entire description is a copy of their title -
 * fifteen characters - and they name a programme FAMILY the way a nav link
 * does.
 *
 * "apprenticeship", "insight", "spring week" and "placement" join the list
 * because they are programme families this product recognises, so a bare one
 * is exactly as much a heading as a bare "Internships" is.
 */
const BARE_PROGRAMME = /^(summer|winter|spring|early)?\s*(internships?|internship programme?s?|graduate programme?s?|campus recruiting|early careers?|early insights?|students? (and|&) graduates?|apprenticeships?|insights?|insight (weeks?|programmes?)|spring weeks?|placements?|programmes?)\s*$/i;

/**
 * Words that say only "this is a programme", never WHICH programme.
 *
 * The vocabulary a careers-page heading is built from. A title made of
 * nothing but these names a family; a title carrying anything else is naming
 * something particular. See looksSpecific for why this replaced a list of
 * sixteen cities.
 */
const PROGRAMME_VOCAB = new Set([
  "summer", "winter", "spring", "autumn", "fall", "early", "campus",
  "student", "students", "graduate", "graduates", "undergraduate",
  "intern", "interns", "internship", "internships",
  "programme", "programmes", "program", "programs",
  "recruiting", "recruitment", "career", "careers",
  "insight", "insights", "week", "weeks",
  "apprenticeship", "apprenticeships", "placement", "placements",
  "opportunity", "opportunities", "experience", "scheme", "schemes",
  "and", "or", "the", "our", "for", "of", "in", "at", "to", "a", "an",
]);

function looksSpecific(title: string): boolean {
  // A year, a location, a desk, a seniority word, or a parenthetical - any one
  // of these is the difference between a heading and an opening.
  return (
    /\b20\d{2}\b/.test(title) ||
    /\((?!\s*\d+\s+results)/i.test(title) ||
    /**
     * A qualifier after the programme word.
     *
     * "Summer Internship, Equity Research" names a desk and is unmistakably an
     * opening, but it carried no year, no city, no parenthetical, and no bare
     * "intern" (the word is "Internship", which fails `\bintern\b`) - so it was
     * filed as "names a programme family", and a non-posting is dropped
     * WITHOUT review. Found by posting-quality.test.ts.
     *
     * The separator must be a comma, a colon, or a SPACED dash, so that
     * "Off-Cycle" and "Early-Careers" do not qualify themselves through an
     * ordinary intra-word hyphen. A heading - "Internships", "Internship
     * Programme", "Students and Graduates" - carries no such qualifier, which
     * is exactly the distinction being drawn.
     */
    /(?:,|:|\s[–—-]\s)\s*\S{3,}/.test(title) ||
    /\b(analyst|associate|intern|trainee|placement)\b/i.test(title) ||
    /**
     * A word that is not programme vocabulary.
     *
     * This replaces a HARDCODED list of sixteen cities, which meant anywhere
     * else on earth failed the test. Starwood Capital's "Japan Acquisitions
     * Internship" was DROPPED on the first live non-banking crawl - a real
     * internship at a real firm, filed as page furniture and therefore never
     * reviewable. Tokyo was on the list; Japan was not.
     *
     * Enumerating the qualifying words is the wrong shape for this: there are
     * as many as there are places and desks. Enumerating the GENERIC ones is
     * finite. A heading is built entirely out of programme vocabulary -
     * "Internship Programme", "Early Insights", "Students and Graduates" -
     * and a title carrying any word from outside that set is naming something
     * particular.
     *
     * Deliberately lenient. This rule decides DROPPED versus reviewed, and
     * dropped is invisible: being too strict costs a real internship nobody
     * ever sees, being too loose costs a reviewer a glance at a heading.
     */
    title
      .toLowerCase()
      .split(/[^a-z0-9&+#]+/)
      .filter(Boolean)
      .some((word) => !PROGRAMME_VOCAB.has(word))
  );
}

export function assessPostingQuality(listing: NormalizedListing): QualityVerdict {
  const reasons: string[] = [];
  const title = listing.title.trim().replace(/\s+/g, " ");
  const description = listing.descriptionRaw.trim();

  /**
   * Length is measured on the ROLE, not on the offices listed after it.
   *
   * A trailing parenthetical is where firms put the things that are not the
   * role - the cities it runs in, the entity, the language. BDO posts
   * "Advisory Intern, Management Consulting, People Strategy & Solutions -
   * Summer 2027 (Boston, Denver, Los Angeles, New York City, San Francisco)":
   * 141 characters, over the cap by ONE, of which 61 are a list of offices.
   * It was filed as "a paragraph, not a role" with needsHumanReview false -
   * dropped, and invisible - and it is a real consulting internship.
   *
   * Raising the cap would be the wrong fix, because the thing being guarded
   * against is real: Deutsche Bank's board emits 160-character sentences of
   * marketing copy that are not roles at all, and those carry no parenthesis
   * and stay rejected. Multi-city postings are the house style of consulting
   * and accounting firms in particular, which is exactly the sector this cap
   * was quietly costing us.
   *
   * MIN_TITLE still measures the whole title: a title that is short once its
   * cities are removed is still a title someone can read.
   */
  const titleCore = title.replace(/\s*\([^()]*\)\s*$/, "").trim() || title;

  if (title.length < MIN_TITLE) reasons.push(`title is ${title.length} characters - too short to be a role`);
  if (titleCore.length > MAX_TITLE) reasons.push(`title is ${titleCore.length} characters - a paragraph, not a role`);

  /**
   * An address is not a posting.
   *
   * Bourne Partners' careers page offers "Contact us about internship
   * opportunities" behind a `mailto:` link, and the generic connector stored
   * it as a vacancy - title, no description, into the review queue. A
   * `mailto:` or `tel:` link is an invitation to get in touch, which is the
   * opposite of a posting somebody can apply to, and no amount of reading the
   * title will establish that. Checked on the URL because that is where the
   * evidence is.
   */
  if (/^\s*(mailto|tel):/i.test(listing.listingUrl ?? "")) {
    reasons.push("links to an email address or phone number, not a job posting");
  }

  for (const { pattern, reason } of UI_FURNITURE) {
    if (pattern.test(title)) { reasons.push(reason); break; }
  }
  for (const { pattern, reason } of PROSE_MARKERS) {
    if (pattern.test(title)) { reasons.push(reason); break; }
  }
  /**
   * A bare programme name is a heading; a role with no programme word in it is
   * simply a job.
   *
   * The specificity test only applies to titles that name a programme family,
   * because that is the shape a careers-page heading takes - "Internship
   * Programme", "Summer Internships". Applied to every title it rejected real
   * postings for the crime of being ordinary: "Commercial Banking Compliance
   * Officer" has no year, no city and no parenthetical, and was filed as "not
   * a posting" when it is plainly a posting that simply is not an internship.
   *
   * That distinction matters beyond tidiness. A non-posting is dropped without
   * review; a posting that is not relevant is REJECTED, which is a different
   * record and an overturnable one. Mislabelling the second as the first hides
   * a real listing behind the wrong reason.
   */
  // Same vocabulary as BARE_PROGRAMME - a title naming one of these families
  // has to be specific to be an opening rather than a heading.
  /**
   * "student", "graduate", "scheme" and "opportunities" belong here too.
   *
   * Without them the specificity test never RAN for "Student Opportunities"
   * or "Graduate Schemes" - as plain a pair of careers-page headings as
   * exists - and both sailed through as postings. The list held the words for
   * what a programme IS and missed the words for who it is FOR.
   *
   * Safe to widen now that looksSpecific accepts any non-programme word: a
   * real "Graduate Analyst, London" or "Student Brand Ambassador" still
   * qualifies on its own vocabulary, so the only titles this newly catches
   * are the ones built entirely out of heading words.
   */
  const namesAProgramme =
    /\b(internships?|programmes?|programs?|schemes?|early careers?|campus|apprenticeships?|insights?|spring weeks?|placements?|students?|graduates?|opportunit(y|ies))\b/i.test(
      title,
    );
  if (BARE_PROGRAMME.test(title) || (namesAProgramme && !looksSpecific(title))) {
    reasons.push("names a programme family rather than a specific opening");
  }

  const descriptionIsStub =
    description.length < 80 || description.replace(/\s+/g, " ") === title;

  /**
   * A real id from the source system, as opposed to one we synthesised.
   *
   * This is the line between "we could not read its description yet" and "this
   * is not a posting". A Workday requisition id or a Greenhouse job id means a
   * real record exists in a real applicant-tracking system - a filter control
   * and a paragraph of marketing copy do not have one. Several connectors
   * (iCIMS, Eightfold, Goldman) currently return no description at all, so
   * requiring one to count as a posting would throw away 150 genuine Stifel
   * openings for a shortcoming on our side rather than theirs.
   */
  const hasSourceId = Boolean(listing.externalJobId);

  /**
   * A title that names a specific, dated opening is itself evidence.
   *
   * "no id and no body" is a good test for page furniture and a bad one for a
   * posting we merely failed to READ. The generic connector synthesises no id
   * and leaves the description as the link text, so a listing whose detail
   * fetch came back a client-rendered shell was filed identically to Nomura's
   * filter control - DROPPED, which means never queued and never overturnable.
   *
   * The four incidents this rule is credited with are all caught by the rules
   * above it: the filter control by UI_FURNITURE, the marketing sentence by
   * PROSE_MARKERS, the nav link and the category pages by BARE_PROGRAMME. What
   * this rule uniquely removes is the un-enrichable real posting.
   *
   * So it is narrowed by one exception, and deliberately a strict one: a YEAR,
   * a parenthetical, or a named city. A role word is not enough - "Summer
   * Analyst" on its own is exactly the nav link Deutsche Bank published - but
   * "2027 Investment Banking Summer Analyst - New York" is not something a
   * careers page says by accident.
   *
   * This does not publish anything. `verifiable` below still requires a real
   * id and a real body, so these land in the review queue where a person can
   * open the link, which is the whole difference between a posting we could
   * not read and a fragment that was never one.
   */
  const namesASpecificOpening =
    /\b20\d{2}\b/.test(title) ||
    /\((?!\s*\d+\s+results)/i.test(title) ||
    /\b(new york|london|chicago|hong kong|singapore|san francisco|boston|dallas|houston|charlotte|los angeles|tokyo|frankfurt|paris|dubai|toronto|milwaukee)\b/i.test(
      title,
    );

  if (descriptionIsStub && !hasSourceId && !namesASpecificOpening) {
    reasons.push(
      "no description and no id from the source system - nothing that shows a posting exists",
    );
  }

  // A listing that points at the board it was found on has no address of its
  // own, which is what a real posting always has.
  /**
   * An address a student can actually open.
   *
   * This was `Boolean(listing.listingUrl && applicationUrl !== null)`, which a
   * RELATIVE path satisfies. Measured 11 October 2026: 3,376 stored listings
   * across 6 sources carry a `listing_url` like `/careers/job/859036991068` -
   * non-empty, non-null, and useless once it leaves the board it came from.
   * Published, that is a dead link in front of a student.
   *
   * The honest fix is also at the source - a connector should resolve a
   * relative href against the board URL, and the generic connector does
   * because the browser absolutises `anchor.href` for it. Until the six
   * offenders are found, this stops the broken ones being publishable rather
   * than publishing them and hoping.
   */
  const hasAbsoluteUrl = /^https?:\/\//i.test(listing.listingUrl ?? "");
  const hasOwnUrl = hasAbsoluteUrl && listing.applicationUrl !== null;

  /**
   * Verifiable is the stricter bar, and it governs AUTO-APPROVAL only.
   *
   * A posting with an id but no description is real, and belongs in the review
   * queue where a person can open it. It must not be published unread: the
   * description is also where eligibility is stated, so publishing without one
   * means guessing who the posting is for.
   *
   * A VENDOR ID IS NOT THE ONLY EVIDENCE, and requiring it excluded an entire
   * connector.
   *
   * `hasSourceId` reads the requisition id the connector was given. An ATS
   * hands one over for free; the GENERIC connector never can, because a
   * scraped careers page has no applicant-tracking record behind it. (The id
   * stored in the database for those rows is a hash of the URL, added by
   * monitor-run after this runs - the classifier only ever sees null.)
   *
   * Measured 20 September 2026, after enrolment took the crawl from 188
   * sources to 4,889: 97.3% of sources are on the generic connector, so
   * almost nothing the crawler now finds could ever auto-approve. 23 of the
   * first 25 listings queued from the new sources were held on this alone -
   * including D. E. Shaw's "Quantitative Analyst Intern (New York) - Summer
   * 2027", which carries a 2027 cycle, a sector, its own detail URL and 460
   * characters of the firm's own prose. It is not unverifiable. It is a real
   * posting from a firm that does not run an ATS we can read.
   *
   * So the bar is now the EVIDENCE rather than its format: either the source
   * system gave us an id, or the posting has its own address and enough of
   * the firm's own text to judge it by. 300 characters is well clear of the
   * 80-character stub line above, and is more than a breadcrumb, a nav link
   * or a filter control ever carries.
   */
  const SUBSTANTIAL_DESCRIPTION = 300;
  const hasItsOwnAccount = description.trim().length >= SUBSTANTIAL_DESCRIPTION;
  const verifiable = (hasSourceId || hasItsOwnAccount) && !descriptionIsStub && hasOwnUrl;

  return { ok: reasons.length === 0, reasons, verifiable };
}

/**
 * The recruiting cycles a posting may claim, as of `now`.
 *
 * Finance runs roughly 18 months ahead, so in autumn 2026 the live cycles are
 * Summer 2027 (filling) and Summer 2028 (opening). A posting claiming 2023 is
 * not an opening at all - it is almost always a page fragment whose year came
 * from a copyright line or an old case study, which is exactly how Deutsche
 * Bank's marketing sentence got published with `recruitingCycle: 2023`.
 *
 * The window is generous at the top (three cycles out) because a firm posting
 * unusually early is a real thing that should not be thrown away, and hard at
 * the bottom because a past summer cannot be applied to.
 */
export function liveCycleRange(now = new Date()): { min: number; max: number } {
  const year = now.getFullYear();
  // From April the current calendar year's summer has effectively run.
  const min = now.getMonth() >= 3 ? year + 1 : year;
  return { min, max: year + 3 };
}

export function isStaleCycle(cycle: number | null, now = new Date()): boolean {
  if (cycle === null) return false; // "unknown" is not "stale" - a different problem
  const { min, max } = liveCycleRange(now);
  return cycle < min || cycle > max;
}
