import "server-only";
import type { FirmProgramCategory } from "@/lib/firm-metadata";
import { publicHttpUrl } from "@/lib/safe-url";
import type { NormalizedListing } from "./connectors/types";
import { assessPostingQuality, isStaleCycle, liveCycleRange } from "./posting-quality";
import { readEligibility, type Eligibility } from "./eligibility";
import { extractRequirements, splitRequirements } from "./requirements";

// Layer 1: deterministic title/year/division/location/description rules.
// No model call anywhere in this file - every finding here has to be
// traceable to a specific matched phrase (see `matchedEvidence`), which is
// also what makes a human review fast: the admin sees exactly why the
// classifier landed where it did.
//
// Sector uses the same FirmProgramCategory the rest of the firm directory
// already does (14 values), not the narrower 8-value QuizCategory Discovery's
// student-preference filter uses - see internship-postings.ts's
// PublishablePosting comment for the gap that leaves between them.

export type Classification = {
  relevant: boolean;
  sector: FirmProgramCategory | null;
  subsector: string | null;
  recruitingCycle: number | null;
  confidence: number; // 0-1
  matchedEvidence: string[];
  reasonForUncertainty: string | null;
  needsHumanReview: boolean;

  /**
   * Whether this is a job posting at all, separately from whether it is a
   * relevant one. Added after the first live crawl auto-approved a filter
   * control and two sentences of marketing copy - see posting-quality.ts for
   * the specific rows. A listing that fails here is never relevant, whatever
   * its words say.
   */
  isPosting: boolean;
  qualityIssues: string[];
  /** Has a stable external id, a body of its own and its own address - the
   *  marks of a record from a real system rather than something recovered from
   *  a page's markup. Required for auto-approval. */
  verifiable: boolean;
  /** True when the cycle is in the past (or implausibly far ahead). */
  staleCycle: boolean;

  /** Who may apply, read from the posting where it says so. */
  eligibility: Eligibility;
  /** The employer's own requirements text, verbatim, or null. */
  requirementsRaw: string | null;
  /** That section split into lines, when it is written as a list. */
  requirementsList: string[];
};

// Titles that read as an internship on their own words but are one of the
// things the product explicitly does not want tracked. Checked before
// anything else - a match here forces relevant=false regardless of what
// sector keywords also appear (a "Senior Investment Banking Analyst" says
// "investment banking" too, and that's exactly the case this has to catch).
/**
 * Wrong profession, not wrong seniority - and unlike EXCLUSION_RULES below,
 * a relevance phrase in the title does NOT overturn these.
 *
 * That distinction is the whole reason this list is separate. Every rule in
 * EXCLUSION_RULES describes something that only LOOKS like an internship, so
 * "Summer Analyst" in the title settles it. These describe things that
 * genuinely ARE internships and are simply not the ones this product covers:
 * "Tax Intern, Core Tax Services - Summer 2028 (Dallas)" is a real, open,
 * well-paid internship, it says "Intern" twice, and no student using Offerly
 * is looking for it.
 *
 * They arrive because several firms here are the advisory arm of an
 * accounting practice and recruit on the parent's board - BDO Capital
 * Advisors on BDO USA's, Baker Tilly Capital on Baker Tilly's, Stout on
 * Stout's. The board is the right one; it just also carries the audit and tax
 * practice. With the firm registered under investment_banking, the sector
 * fallback then stamped `investment_banking` on every one of them, and
 * "Assurance Intern - Summer 2028 (Atlanta)" reached students as a banking
 * opening.
 *
 * Scoped to the title like everything else here: a banking description that
 * mentions tax structuring is still a banking posting.
 */
const OFF_PROFESSION_RULES: { pattern: RegExp; reason: string }[] = [
  {
    // "transfer pricing", "trade and customs" and "indirect tax" are tax
    // practice lines that never use the word "tax" in their title. Found by
    // re-classifying the corpus: Kroll's "Intern, Transfer Pricing" and
    // "Intern, Trade and Customs" were both reaching students as banking
    // openings, on a board registered under investment_banking.
    /**
     * The French half, added 20 September 2026 with the French internship
     * vocabulary that made these titles visible in the first place.
     *
     * Recognising "Stage" as an internship is what surfaced Rothschild's Paris
     * and Luxembourg board - and the very first run auto-approved "Stage
     * Comptabilite et Reporting Luxembourg - Janvier 2027", an ACCOUNTING
     * internship, as investment banking. The English side of this rule was
     * working perfectly well: two dozen "Internal Audit Summer Analyst" rows
     * are correctly rejected. It simply had no word for the same job in
     * French.
     *
     * That is the shape of the risk in adding vocabulary to one list and not
     * the other, and the reason this rule moves whenever the relevance list
     * does: a phrase list that can see a posting but not classify it produces
     * a confident wrong answer instead of a silent miss.
     *
     * "fiscalite" and "fiscaliste" rather than a bare "fiscal", which is an
     * ordinary English word in "fiscal year" and would reject real roles.
     */
    /**
     * Lookarounds, not `\b`, because of the accent.
     *
     * `\b` marks a boundary between a word character and a non-word one, and
     * JavaScript does not count "é" as a word character without the `u` flag.
     * So `/\bcomptabilité\b/` requires a boundary AFTER "é" - where the next
     * character is a space, which is also a non-word character - and never
     * matches at all. It reads as though it works, and silently matches
     * nothing, which is the worst way for a rule in this file to fail.
     */
    pattern:
      /(?<![a-z])(tax|assurance|audit(ing|or)?|transfer pricing|trade and customs|customs|indirect tax|vat|comptabilit[ée]|comptable|fiscalit[ée]|fiscaliste)(?![a-z])/i,
    reason: "accounting practice role (tax/assurance/audit/comptabilité), not finance",
  },
  /**
   * Legal and HR, on exactly the same footing as tax.
   *
   * Found by auditing the corpus. These are real, open internships at real
   * financial firms - "Stage H/F - Juriste Corporate", "2027 Human Resources
   * Summer Analyst Program - New York" - and no student using Offerly is
   * looking for them, which is the test this list has always applied.
   *
   * Scoped to the ROLE, not to any mention. "2027 Campus Recruiting -
   * Investment Banking Summer Associate" is a banking internship posted BY
   * campus recruiting, and five of those are live: the department that
   * publishes a role is not the role. So "recruiting" is absent here and the
   * HR words are the ones that name a job in HR.
   */
  {
    /**
     * Bare "legal", which the list somehow never had.
     *
     * It was built from the specific titles the corpus happened to show -
     * "Stage H/F - Juriste Corporate", "legal counsel", "paralegal" - and
     * missed the plainest English form there is. "2027 Legal Summer Intern"
     * was AUTO-APPROVED and would have reached students as a finance opening,
     * which is exactly what this rule was added to stop and what its own
     * comment says legal is on the same footing as tax for.
     *
     * "legal entity" is spared: at a bank, Legal Entity Control is a finance
     * function staffed by accountants, not lawyers. Found by
     * cross-industry.test.ts.
     */
    pattern:
      // Bare "juridique" as well as "direction juridique": Rothschild posts
      // "Stage H/F - Assistant Juridique en Asset Management", which the
      // two-word form cannot see. The word has no non-legal sense in French.
      /(?<![a-z])(legal(?!\s+entity)|juriste|juridique|paralegal|attorney|solicitor|law clerk|rechtsanwalt)(?![a-z])/i,
    reason: "legal role, not finance",
  },
  {
    /**
     * `HR` as well as "human resources", because the abbreviation is how the
     * title is actually written.
     *
     * The spelled-out form was rejecting 70 listings while the abbreviation
     * sailed through. Measured 13 October 2026: 12 relevant listings carry
     * `HR` in the title and 7 were LIVE to students - Archimed's "HR
     * Internship (Lyon, France)", Pai Partners' "Talent & Development HR
     * Internship", Group 11's "Praktikant im Bereich HR Learning & Talent
     * Development" and "Praktikant Recruiting & HR Marketing". Every one is a
     * real internship, which is why nothing else caught them, and none of them
     * is a finance internship.
     *
     * NOT ONE of those 12 titles also names a finance function - no finance,
     * investment, banking, equity, credit, M&A, portfolio, research or
     * trading - so the abbreviation costs nothing here. `\bHR\b` is
     * case-insensitive and bounded, so it cannot reach into a longer word.
     */
    pattern: /\b(human resources|hr|talent acquisition|ressources humaines|personalwesen|compensation (and|&) benefits)\b/i,
    reason: "human resources role, not finance",
  },
  /**
   * Skilled trades, on the same footing as tax, legal and HR.
   *
   * A private equity firm's portfolio company posts on the firm's own board,
   * so its vacancies arrive under the firm's sector. Guild Garage Group is a
   * portfolio company that fits garage doors, and seven of its technician
   * apprenticeships were sitting in the review queue filed as private equity
   * and insurance internships.
   *
   * Matched on the TRADE, never on "apprentice". That word is real finance
   * vocabulary in the UK and Europe - Rothschild's own careers page lists
   * "Apprenticeships" beside its internships, and several banks recruit
   * school leavers that way. Excluding on it would drop genuine openings,
   * which is the expensive direction. A garage door is unambiguous; an
   * apprentice is not.
   */
  {
    pattern:
      /\b(garage door|hvac|electrician|plumber|plumbing|welder|carpenter|locksmith|roofer|glazier|machinist|install technician|installation technician|service technician|field technician|maintenance technician|delivery driver|truck driver|warehouse associate)\b/i,
    reason: "skilled trades role, not finance",
  },
];

/**
 * Why this title is off-profession, or null.
 *
 * Exported because the rule has to be applied in two places and must not be
 * written twice: here, where a newly seen listing is judged, and in
 * scripts/retire-off-profession-postings.ts, which re-judges the rows that
 * were promoted into internship_postings before the rule existed. A cached
 * verdict does not re-evaluate itself.
 */
/**
 * Can this listing be published with no human in the loop?
 *
 * ONE definition, because three different writers were each deciding it for
 * themselves and quietly disagreeing:
 *
 *   monitor-run.ts        stored `auto_approved` on !needsHumanReview
 *   reclassify-listings   promoted pending -> `auto_approved` on the same test
 *   promote-approved      refused to publish anything with no recruitingCycle
 *
 * `internship_postings.program_year` is NOT NULL and students read it as
 * "Summer 2027", so the third one is the binding constraint: a listing with no
 * cycle cannot become a posting however confident the classifier is. With the
 * first two using a looser test, `auto_approved` came to mean two things at
 * once, and cycle-less rows cycled between the states forever - promotion set
 * them back to `pending_review`, the next reclassify pass read
 * needsHumanReview and set them to `auto_approved` again, and the next
 * promotion held them once more. Neither step was wrong on its own terms.
 *
 * So `auto_approved` now means exactly one thing: ready to publish. A row
 * that needs a programme year is `pending_review`, which is where a human can
 * actually supply one.
 *
 * This is NOT the cycle requirement that was removed on 20 September 2026.
 * That rule made a missing cycle a reason to REJECT the listing outright, as
 * not an internship, which is what punished every sector that does not date
 * its job titles. This only withholds AUTO-APPROVAL.
 *
 * WHERE A MISSING CYCLE NOW LANDS. This doc used to end "a missing cycle is a
 * reason to ask a person, and nothing here rejects anything", and said such a
 * row goes to `pending_review` "where a human can actually supply one". Both
 * call sites now reject it instead: routing is binary, `reviewStatusAfterReread`
 * was narrowed to match, and `promote-approved-listings.ts` withholds rather
 * than holds. `reviewed_by` was NULL on all 21,716 rows, so the person this
 * was waiting for did not exist.
 *
 * Nothing is destroyed by that. The rejection states its reason - carrying the
 * phrase "recruiting-cycle", which `adjudicate-rejections.ts` selects on - and
 * that script reads the year out of the posting's own prose with a verbatim
 * quote. This function is still the thing that decides whether the result is
 * publishable; the model only supplies the missing fact.
 */
export function publishableWithoutReview(classification: {
  needsHumanReview: boolean;
  recruitingCycle: number | null;
}): boolean {
  return !classification.needsHumanReview && classification.recruitingCycle !== null;
}

/**
 * Are this listing's own URLs ones a student may be sent to?
 *
 * Both of them, because both reach an href: `source_url` is "Read the full
 * posting" and `application_url` is "Apply". The listing URL is required -
 * there is no posting without an address - and the application URL is
 * optional, so a null one is fine and a present-but-bad one is not.
 *
 * Exported so the publish step can ask the same question of a row that was
 * classified before this rule existed (scripts/promote-approved-listings.ts).
 */
export function hasPublishableUrls(listing: {
  listingUrl?: string | null;
  applicationUrl?: string | null;
}): boolean {
  if (!publicHttpUrl(listing.listingUrl)) return false;
  if (listing.applicationUrl != null && !publicHttpUrl(listing.applicationUrl)) return false;
  return true;
}

/**
 * The statuses a MACHINE may write. `pending_review` is deliberately absent.
 *
 * It stays in the database enum (src/db/schema.ts) because 21,716 historical
 * rows carry it, and an admin's own verdict still writes whatever an admin
 * likes. Nothing automated routes a listing there any more - see the BINARY
 * note in scripts/monitor-run.ts for the measurement behind that: `reviewed_by`
 * was NULL on every one of those rows, so the queue had never once been worked.
 */
export type ReviewStatus = "rejected" | "auto_approved";

/**
 * The review status a re-read listing should carry.
 *
 * "A person's verdict is not a machine's to revisit" - the rule
 * adjudicate-rejections.ts and reclassify-listings.ts both already enforce,
 * written here so the third caller cannot forget it. `backfillThinListings`
 * in scripts/monitor-run.ts did forget it: it re-read the detail page of
 * every thin listing, re-classified it and wrote `reviewStatus`
 * unconditionally, so a listing an admin had REJECTED could be flipped to
 * `auto_approved` and published by the very next promote step in the same
 * hourly run (security review, 10 October 2026). `reviewedBy` is the only
 * discriminator there is - the machine and a human write the same status
 * values - so a non-null one means hands off.
 *
 * Returns null when the status must not change. Fresh description and
 * classification are still worth storing on such a row; only the verdict is
 * off limits.
 *
 * ONE RULE, TWO CALL SITES. The outcome is decided by
 * `publishableWithoutReview`, exactly as the first-read path in monitor-run.ts
 * decides it. This used to read `needsHumanReview ? "pending_review" :
 * "auto_approved"`, which differed from that path twice over: it queued what
 * the other path rejects, and it published a listing with no programme year
 * that the other path holds back. A re-read is fresher evidence about the same
 * listing, so it must not be able to reach a verdict the first read could not.
 */
export function reviewStatusAfterReread(
  reclassified: {
    relevant: boolean;
    needsHumanReview: boolean;
    recruitingCycle: number | null;
  },
  existing: { reviewedBy: string | null },
): ReviewStatus | null {
  if (existing.reviewedBy !== null) return null;
  if (!reclassified.relevant) return "rejected";
  return publishableWithoutReview(reclassified) ? "auto_approved" : "rejected";
}

/**
 * INTERNAL AUDIT AT A BANK IS A FINANCE ROLE, NOT AN ACCOUNTING PRACTICE.
 *
 * The accounting-practice rule exists to exclude tax, assurance and audit
 * work at an accounting firm - "Tax Intern, Core Tax Services" at BDO. Its
 * `audit` arm fires on the word wherever it appears, and that caught a
 * different job entirely: a bank's own Internal Audit division, which
 * recruits undergraduates into the same summer-analyst programmes as its
 * markets and banking divisions.
 *
 * Measured 11 October 2026 - and the first version of this comment overstated
 * it. Of the firms posting an internal-audit role, all but one are banks
 * registered under investment_banking: MUFG (13),
 * Citigroup (13), Morgan Stanley (10), Nomura (10), Mizuho (4), Greenhill (4),
 * Raymond James (3), Barclays (2), Jefferies (2). Not one is an accounting
 * practice. THE EXCEPTION, found by a per-sector regression audit rather than
 * by the per-firm query this was written from: Blockchain Capital, LLC, a
 * venture firm, has a source scraping Coinbase's Greenhouse board, so
 * "Internal Audit Analytics Intern" arrived under a venture firm's name.
 * Hence BANK_AUDIT_SECTORS below - the exemption needs something to check
 * against, and "the title says internal audit" is not it.
 *
 * Among the genuine ones: "2027 Internal Audit Summer Analyst Program" (Nomura,
 * Jefferies) and "2027 Internal Audit - Business Audit Summer Analyst"
 * (Morgan Stanley) - 83 listings in total, every one excluded as "not
 * finance".
 *
 * Checked as a phrase on the whole scope rather than as a lookbehind on
 * `audit`, because Morgan Stanley's title contains BOTH "Internal Audit" and
 * "Business Audit" and a lookbehind would still reject it on the second.
 *
 * This exempts the posting from the ACCOUNTING rule only. Everything else
 * still applies: a senior internal-audit role is still rejected by the
 * experienced-hire rules, which is why narrowing this does not let "Assistant
 * Vice President - Professional Practices, Internal Audit" through.
 */
const BANK_INTERNAL_AUDIT = /\binternal\s+audit\b/i;

/**
 * The sectors where "internal audit" means a bank's own audit division.
 *
 * The exemption was first written WITHOUT this gate, on a premise that a
 * per-firm query seemed to support and that turned out to be false: "every
 * firm in the corpus posting an internal-audit role is a bank". One is not.
 * Blockchain Capital, LLC - a venture firm, sector `venture_capital` - has a
 * monitoring source that scrapes Coinbase's Greenhouse board, and
 * "Internal Audit Analytics Intern" (boards.greenhouse.io/coinbase/jobs/8221238)
 * became publishable under the venture firm's name. Coinbase is not a bank
 * and Blockchain Capital is not an accounting practice; the exemption simply
 * had nothing to check against.
 *
 * Found by a per-sector regression audit, which is why that audit covers all
 * fourteen sectors rather than the one the feature was built for.
 */
const BANK_AUDIT_SECTORS: ReadonlySet<string> = new Set([
  "investment_banking",
  "commercial_banking",
  "market_infrastructure",
]);

export function offProfessionReason(
  title: string,
  division?: string | null,
  /** The firm's registered sector. Without it the exemption does not apply:
   *  "we do not know what kind of firm this is" is not evidence that it is a
   *  bank. */
  sector?: string | null,
): string | null {
  const scope = `${title} ${division ?? ""}`.toLowerCase();
  const bankAudit = BANK_INTERNAL_AUDIT.test(scope) && BANK_AUDIT_SECTORS.has(sector ?? "");
  return (
    OFF_PROFESSION_RULES.find((r) => {
      if (bankAudit && r.reason.startsWith("accounting practice role")) return false;
      return r.pattern.test(scope);
    })?.reason ?? null
  );
}

/**
 * `hard` means: this beats an internship phrase in the title.
 *
 * Exclusions are normally skipped when the title says "summer analyst" or
 * similar, on the reasoning that an internship phrase is the strongest signal
 * there is. That is right for almost all of them and wrong for one shape: a
 * board row that covers BOTH audiences at once.
 *
 * Evercore posts a row literally titled "Lateral / Experienced Hires
 * (US/Canada/APAC) - Summer Analyst". It ends in "Summer Analyst", so
 * `titleSaysInternship` is true, so the exclusion below never ran at all -
 * the rule was written for this exact title and could not fire on it. What
 * held the row back was an unrelated accident: it states no recruiting cycle,
 * and auto-approval used to require one. Remove that requirement for the
 * sectors it was unfairly punishing and this landing page walks straight
 * through to students.
 */
/**
 * Does this text mention a year, and is every year it mentions dead?
 *
 * Deliberately narrow. A posting that says nothing about its cycle says
 * nothing, and most sectors outside investment banking never state one - so
 * "no years at all" must return false, or this becomes the blanket cycle
 * requirement it replaced.
 *
 * Only years that are plausibly recruiting cycles are considered at all;
 * a founding date of 1932 or an address with a number in it is not evidence
 * about a recruiting cycle.
 */
function mentionsOnlyDeadYears(text: string): boolean {
  const { min, max } = liveCycleRange();
  const years = [...text.matchAll(/\b(20\d{2})\b/g)]
    .map((m) => Number(m[1]))
    // A window around the live range: older than this is company history,
    // not a cycle anybody could be recruiting for.
    .filter((y) => y >= min - 8 && y <= max + 2);
  if (years.length === 0) return false;
  return years.every((y) => y < min || y > max);
}

const EXCLUSION_RULES: { pattern: RegExp; reason: string; hard?: boolean }[] = [
  { pattern: /\b(senior|staff|principal|vice president|vp|director|managing director|md)\b/i, reason: "reads as an experienced-hire title" },
  { pattern: /\bfull[- ]?time\b(?!.*\b(intern|internship)\b)/i, reason: "full-time with no internship language" },
  { pattern: /\b(graduate|masters?|mba)\b.*\bprogram\b(?!.*\bintern)/i, reason: "graduate-only program, not an internship" },
  { pattern: /\b(software engineer|swe|devops|site reliability|data engineer)\b/i, reason: "technology role, not finance" },
  { pattern: /\b(janitorial|facilities|security guard|receptionist|barista)\b/i, reason: "operational/facilities role" },
  // Evercore posts a board row literally titled "Lateral / Experienced Hires
  // (US/Canada/APAC) - Summer Analyst". It ends in "Summer Analyst", so every
  // relevance rule fires, and it is an experienced-hire landing page.
  {
    pattern: /\b(lateral|experienced hires?|experienced professionals?)\b/i,
    reason: "lateral/experienced-hire posting",
    // Hard: a row addressed to experienced hires is not a student posting
    // even when it also names a student role.
    hard: true,
  },
  /**
   * OFFERLY IS FOR UNDERGRADUATES. A graduate-degree programme is not ours.
   *
   * The students on this product graduate in 2027, 2028 and 2029 - they are
   * undergraduates, and an MBA or PhD programme is closed to them however
   * plainly it says "internship". Showing them one is worse than showing them
   * nothing: it is a real opening they cannot apply to, indistinguishable on
   * the page from one they can.
   *
   * The rule above - `(graduate|masters?|mba).*program` - already tried, and
   * could not fire, because it carries `(?!.*\bintern)` to avoid catching
   * internships. That is exactly backwards here: an MBA INTERNSHIP is still
   * an MBA internship. Five had reached students by 20 September 2026:
   *
   *   BlackRock         MBA Internship Program
   *   BlackRock         Quantitative Master's Internship Program
   *   D. E. Shaw        Quantitative Analyst, Ph.D. Intern (New York)
   *   Leerink Partners  Equity Research Intern (PhD, Summer 2027)
   *   Morgan Stanley    2027 Investment Banking Summer Associate (MBA)
   *
   * HARD, because every one of those names a student role as well - "Summer
   * Associate", "Intern", "Internship Program" - so a soft rule would be
   * skipped by the internship phrase it sits next to.
   *
   * NEVER A BARE "master". The corpus has "Derivatives Master Documentation
   * Negotiator" and "Financial Reporting Application and Master Data
   * Manager", where the word means an ISDA master agreement and a master data
   * set. Only the possessive and plural forms name a degree, and the curly
   * apostrophe is included because that is what the boards actually emit.
   */
  {
    pattern: /(?<![a-z])(mba|masters|master['\u2019]s|ph\.?d|doctoral|graduate degree)(?![a-z])/i,
    reason: "graduate-degree programme - Offerly is for undergraduates",
    hard: true,
  },
  /**
   * OFFERLY IS FOR UNDERGRADUATES at the other end too. A placement for
   * SCHOOL pupils is not ours either.
   *
   * The rule above excludes what sits above an undergraduate - an MBA, a PhD.
   * Nothing excluded what sits below, and the gap was invisible because only
   * one posting in the corpus is school-level: Deutsche Bank's "Dein Schul-,
   * FOS- und Berufsorientierungs-Praktikum", a careers-orientation week for
   * pupils, FOS being a German vocational secondary school.
   *
   * It was held back, and only by luck. Its year is not derivable, so it had
   * no recruiting cycle and `publishableWithoutReview` was false. That is an
   * accident, not a guard: `placement` is already in CYCLE_WORDS, so the same
   * posting written in English - "school placement 2027" - would have had a
   * cycle and published. The thing standing between a pupils' taster week and
   * an undergraduate's internship list was a German compound noun.
   *
   * HARD, like the rule above and for the same reason: "praktikum",
   * "praktikant" and "werkstudent" are all in TITLE_INTERNSHIP_PHRASES, so
   * `titleSaysInternship` is true for this title and a soft rule would be
   * skipped by the internship phrase it sits next to.
   *
   * LEADING \b ONLY, which is the whole subtlety. German compounds append:
   * the real title reads "Berufsorientierungs-Praktikum" and "Schul-,", so a
   * trailing \b refuses both - it has to hold between "s" and "-", and
   * between "-" and ",". A first version of this rule carried one and matched
   * neither of the two words it was written for. It was measured with a
   * boundary-free SQL `~*` first, which hid the defect by testing a different
   * pattern from the one that would ship.
   *
   * WHAT IS DELIBERATELY NOT HERE:
   *
   *   - a bare "schul", because "Schulung" is TRAINING and
   *     "Schulungsprogramm Analyst" is a legitimate title. The prefix form
   *     requires its hyphen.
   *   - "hochschul", which is the opposite word: higher education. The
   *     leading \b keeps this rule out of "Hochschulpraktikum" and
   *     "Fachhochschule" on its own.
   *   - "work experience", which is school-coded in UK usage and is already
   *     in TITLE_INTERNSHIP_PHRASES. It matches no title in the corpus, so
   *     adding it would contradict that list for no measured gain.
   *   - "high school" when a qualification FOLLOWS it. 58 relevant listings
   *     say "high school diploma or equivalent" - a floor on a full-time
   *     role, not an invitation to a pupil. None of them say it in a TITLE,
   *     which is why this rule is title-scoped, but the lookahead means it
   *     would still be right if one did.
   *
   * Measured 13 October 2026 against every relevant listing - 6,304 rows
   * across all 14 sector categories, 10 of which carry any - this rule
   * excludes exactly one, and none of the 2,144 already auto-approved.
   */
  {
    pattern:
      /\b(schulpraktikum|sch(?:u|ue|\u00fc)lerpraktikum|schnupperpraktikum|sch(?:u|ue|\u00fc)ler|schul-|berufsorientierung|sixth form|high school(?! diploma| graduate| or equivalent| ged))/i,
    reason: "school-level placement - Offerly is for undergraduates",
    hard: true,
  },
];

// Relevant-internship phrases, from the product's own spec.
const RELEVANCE_PHRASES = [
  "summer analyst",
  "summer associate",
  "off-cycle intern",
  "off cycle intern",
  "investment analyst intern",
  "quantitative trading intern",
  "asset management intern",
  "equity research intern",
  "private credit intern",
  "private equity intern",
  "internship",
  "intern",
];

/**
 * Phrases that make a TITLE an internship.
 *
 * Wider than RELEVANCE_PHRASES, which is matched against the whole posting and
 * can lean on surrounding context. Drawn from the titles these boards actually
 * publish, and deliberately does NOT include a bare "analyst" or "associate":
 * those are the full-time roles this list exists to separate out.
 */
const TITLE_INTERNSHIP_PHRASES = [
  "summer analyst",
  "summer associate",
  "summer intern",
  "internship",
  "intern",
  // PJT posts "2027 January Off-Cycle Analyst" and "2027 July Off-Cycle
  // Analyst" - real internships whose titles never say "intern".
  "off-cycle",
  "off cycle",
  // NOT "analyst program" / "associate program" on their own. In UK and
  // European usage an "Analyst Programme" is the full-time graduate scheme -
  // Jefferies posts "2027 Investment Banking Analyst Programme - London" and
  // "2027 Equity Research Analyst Programme - London", neither of which a
  // student can apply to as an intern. The internship versions all carry
  // "Summer" or "Internship" and match on those instead.
  // UK/European early-exposure programmes, which are internships in all but
  // name and are how several of these firms recruit sophomores.
  "insight",
  "spring week",
  "spring insight",
  "placement",
  "work experience",
  "co-op",
  "coop",
  "trainee",
  "apprenticeship",
  /**
   * The same programmes in the languages these firms post them in.
   *
   * Measured 19 September 2026: 42 rejected listings carried a non-English
   * internship word, and they were real internships. Lazard alone posts a
   * column of them - "Stage H/F - Private Equity - Janvier 2027", "Stage H/F -
   * Analyste ESG" - which is a January off-cycle internship in Paris, rejected
   * for the sole reason that "stage" was not on this list. Any firm with a
   * European desk is in the same position.
   *
   * NOT the bare word "stage", deliberately. In English it is "growth stage",
   * "late stage", "stage manager" - and a false positive here publishes a
   * full-time job to students as an internship, which is the failure this
   * whole list exists to prevent. The French convention writes the gender
   * marker into the title ("H/F", "F/H", "M/F"), and "stagiaire" is the
   * unambiguous noun, so both are safe where "stage" alone is not.
   */
  "stagiaire",
  "stage h/f",
  "stage f/h",
  "stage m/f",
  "praktikum",
  "praktikant",
  "werkstudent",
  "alternance",
  "alternant",
  "tirocinio",
  "becario",
  /**
   * Firms that label the pipeline rather than the role.
   *
   * Piper Sandler posts "Campus Recruiting - 2027 Investment Banking Analyst -
   * Specialty Finance". The role word is "Analyst", which on its own is a
   * full-time job, and the thing marking it as campus hiring is the prefix.
   *
   * "campus recruiting", not "campus": JPMorgan posts "Campus Recruiter,
   * Associate", which is a full-time job recruiting students and must not
   * match. Recruit-ER and recruit-ING is the whole distinction, and it is
   * enough.
   *
   * Audited 19 September 2026 over 1,145 title-only rejections: only 21
   * carried early-career language at all, and all but these were correctly
   * excluded full-time graduate schemes. The list is not over-rejecting; this
   * was the one real gap.
   */
  "campus recruiting",
  "campus program",
  "campus programme",
  // "apprentice" alongside "apprenticeship": D.A. Davidson's "2027 Apprentice
  // Financial Advisor Program" is a real early-career intake and the noun form
  // alone did not reach it.
  "apprentice",
];

/**
 * Shapes a phrase list cannot express, because the words are not adjacent.
 *
 * Found by the labelled eval set on its first run. Houlihan Lokey posts
 * "Summer Financial Analyst 2027 - Financial Restructuring, London" - a real
 * internship that the adjudicator had to recover, because the list holds
 * "summer analyst" and phrasePattern requires the two words to touch. The
 * division name sits between them, which is ordinary in banking titles.
 *
 * Scoped tightly: "summer", then one or two words, then analyst or associate.
 * Two, not one, because re-classifying the corpus found "Summer 2027
 * Financial Analyst (Class of 2028), Corporate Valuation Advisory" - a real
 * internship with both a year AND a division between the words.
 *
 * Not wider than two. The gap is what keeps this from matching prose, and
 * "analyst programme" without "summer" is deliberately excluded elsewhere as
 * the UK graduate scheme.
 */
const TITLE_INTERNSHIP_SHAPES = [
  /\bsummer\s+([\w&/-]+\s+){1,2}(analyst|associate)\b/i,

  /**
   * French. "Stage" is an internship; "alternance" is the work-study contract
   * European banks recruit students on.
   *
   * The rejection-evidence note above already recorded that 42 French-language
   * internships sat rejected without anyone noticing a pattern. These are the
   * postings: Rothschild & Co's Paris board publishes its whole graduate
   * pipeline in French, and every one of them matched no phrase in a list
   * written entirely in English. Measured across sectors rather than just
   * banking - they are investment banking AND private equity, which is the
   * shape of a bank that runs both out of one office.
   *
   *   "Stage Global Advisory / Debt Advisory and Restructuring - Janvier 2027"
   *   "Stage d'Analyste en Private Equity - Fonds Impact Environnemental"
   *   "Alternance - M&A Small & Mid Cap - Transaction R & Co"
   *
   * ANCHORED, not a bare phrase. "Stage" is also an ordinary English word, and
   * venture capital titles are full of it - "Early Stage", "Growth Stage",
   * "Late Stage Investing". Requiring it at the start of the title, or
   * straight after a separator, is what tells a French internship apart from
   * an English company-maturity adjective. "Stagiaire" and "alternance" carry
   * no such ambiguity and match anywhere.
   *
   * This makes them RELEVANT, not published. The off-profession rules already
   * speak some French - "juriste" and "ressources humaines" are both there -
   * so "Stage H/F - Juriste Corporate" becomes a correctly-excluded legal
   * role rather than an invisible one, which is the point: a rejection that
   * can say why beats a silent drop.
   *
   * German, Spanish, Italian and Portuguese are NOT here. No board in the
   * corpus currently publishes in them, and vocabulary added without a
   * posting to check it against is a guess. The shape to copy is this one:
   * anchor the ambiguous word, let the unambiguous ones float.
   */
  /**
   * NOT "Stage Manager". The anchor is not enough on its own.
   *
   * Anchoring `stage` to the start of the title separates a French internship
   * from "Growth Stage" and "Late Stage" - but not from English stagecraft,
   * where the job word comes straight after: "Stage Manager, Events" matched
   * and would have been published to students as an internship. Found by the
   * review agent's own test on 12 October 2026, not by a posting, which is why
   * the list below is the job nouns rather than a guess at every possible one.
   */
  /(?:^|[-–—|:/]\s*)stage\b(?!\s*(?:manager|management|managers|director|producer|designer|technician|hand|crew|lighting|supervisor)\b)/i,
  /\bstagiaire\b/i,
  /**
   * The DUTCH spelling, which is `stagiaire` without its final e.
   *
   * Found by the review agent on 12 October 2026: Egeria's
   * "Stagiair Private Equity June/July 2027" - a real 2027 private equity
   * internship - was rejected by this rule, then correctly identified as an
   * internship when the page was re-read, and then rejected again here. The
   * French spelling was on the list and the Dutch one was not, and a word
   * boundary does not bridge a missing letter.
   *
   * Unambiguous, so it floats rather than being anchored: `stagiair` is not an
   * English word and carries none of `stage`'s company-maturity sense.
   *
   * ITALIAN, PORTUGUESE, POLISH AND SPANISH `pr[áa]cticas` ARE STILL ABSENT,
   * for the reason given above: there is no posting in the corpus to check
   * them against, and vocabulary added without one is a guess. `looksPromising`
   * in llm-adjudicate DOES carry them, and that asymmetry is deliberate - a
   * false positive there costs one model call, a false positive here puts a
   * full-time job in front of a student as an internship.
   */
  /\bstagiair\b/i,
  /\balternan(?:ce|ts?|tes?)\b/i,

  /**
   * German. "Praktikum" is an internship, "Werkstudent" the working-student
   * contract German employers hire undergraduates on.
   *
   * Found the same way the French words were: by asking why a firm's listings
   * were all stuck. Group 11's Getro board carries Munich Re's graduate
   * pipeline, and all sixteen of its queued listings are German -
   * "Werkstudent Aktuariat Pricing (m/w/d)", "Praktikant Business Analytics
   * Bankenkooperation (m/w/d)". They were doubly stuck: unmatched by the
   * phrase list, and therefore also skipped by `shouldRetryEnrichment`, which
   * only re-reads a thin listing whose title reads as an internship. So the
   * one step that could have fetched their descriptions was never run on them.
   *
   * No anchoring needed, unlike "stage". None of these is an English word,
   * and "(m/w/d)" - the German gender-neutral job-ad suffix - is itself a
   * reliable marker that a title is one of these, though the words alone are
   * enough.
   */
  /\bpraktik(?:um|ant|antin)\b/i,
  /\bwerkstudent(?:in)?\b/i,
  /**
   * PORTUGUESE, and only Portuguese, because it is the only one of these the
   * corpus produced a posting for.
   *
   * MUFG Securities' São Paulo "Estagiário" - a real Workday internship,
   * rejected because the title says intern in Portuguese. It sat in the 9,840
   * listings refused for naming no internship phrase, the stratum this rule is
   * the sole reason for and which had never been measured. It is recorded on
   * two rows, the second mis-attributed to Intrepid Investment Bankers, which
   * is a separate firm-attribution bug.
   *
   * `est[áa]gio`, `stagista`, `tirocinante`, `becaria`, `pasant[íi]a` and
   * `praktykant` are NOT here, and this comment exists because they briefly
   * were. `llm-adjudicate` carries all of them, and that difference looks like
   * drift worth tidying. It is not - see the asymmetry in
   * scripts/test/title-pattern-languages.test.ts, which failed and said so:
   * that list is a PRE-FILTER where a false positive costs one model call,
   * while this rule PUBLISHES, where a false positive puts a full-time job in
   * front of a student as an internship. So an ambiguous word may live there
   * and must not come here, and a word with no posting behind it is a guess
   * whichever list it is in.
   *
   * Accent classes rather than bare letters, because boards strip diacritics -
   * and because a regex written with only the accented form silently matches
   * nothing, which is how the first measurement of this missed its own two
   * target rows.
   */
  /\bestagi[\u00e1a]ri[oa]\b/i,
  /**
   * The words that name an UNDERGRADUATE YEAR, and the winter portmanteau.
   *
   * Found by measuring the 9,840 listings rejected for naming no internship
   * phrase - the stratum this rule is the sole reason for, and which had never
   * been measured. Two real programmes were in it:
   *
   *   Weiss Asset Management  "2027 Underclassmen Fellowship"
   *   Bracebridge Capital     "2027 Sophomore Winternship"
   *
   * "Underclassmen" is the US term for first- and second-year undergraduates,
   * so it cannot name anything else; the Weiss posting is live to students
   * today and the current rules would have retracted it on the next
   * re-classification. "Sophomore" and "freshman" are year names in the same
   * way. "Winternship" is winter plus internship and is nothing else.
   *
   * NOT ADDED, measured and read: bare "fellowship" and "scholar". A
   * fellowship can be postdoctoral and a scholar can be senior - the corpus
   * has Forbion's "Fellowship - Investment team" and Blockchain Capital's
   * "Research Scholar - 2026", neither of which is evidently an undergraduate
   * internship. "Underclassmen Fellowship" is caught by its first word
   * instead, which is the unambiguous one.
   */
  /\bunderclassm[ae]n\b/i,
  /\b(sophomore|freshman)\b/i,
  /\bwinternship\b/i,
];

/**
 * The same phrases as a regex, for callers deciding whether a title is WORTH
 * a detail fetch.
 *
 * Exported because monitor-run kept its own hand-written copy of this list and
 * the two drifted, in the way that costs postings rather than the way that is
 * merely untidy. Kroll publishes "Trainee Real Estate Valuation" in Hyderabad.
 * "trainee" is in the list above, so the classifier called it a likely
 * internship - and it was absent from monitor-run's copy, so the listing was
 * never prioritised for enrichment and never re-queued when it came back
 * thin. Confirmed on every check, enriched on none, and with no description
 * there is no eligibility and no requirements, so it could be seen forever
 * and published never.
 *
 * Deriving the regex from the list is what stops that happening again: adding
 * a phrase in one place now adds it in both.
 */
export const TITLE_INTERNSHIP_PATTERN = new RegExp(
  `\\b(${TITLE_INTERNSHIP_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]/g, "[\\s-]")).join("|")})\\b` +
    // The non-adjacent shapes belong here too, or a "Summer Financial Analyst"
    // is classified relevant and then never enriched - confirmed on every
    // check, enriched on none, published never.
    `|${TITLE_INTERNSHIP_SHAPES.map((re) => re.source).join("|")}`,
  "i",
);

const SECTOR_KEYWORDS: Record<FirmProgramCategory, string[]> = {
  // "strategic advisory" and "restructuring" are how the elite boutiques name
  // their banking groups - Evercore posts "Strategic Advisory: Summer
  // Associate Program - Menlo Park Healthcare Group" and nothing in the
  // original list matched it, so a real banking internship scored 0.7 and sat
  // in the review queue instead of reaching students.
  investment_banking: ["investment banking", "ibd", "m&a", "mergers and acquisitions", "leveraged finance", "ecm", "dcm", "coverage group", "strategic advisory", "restructuring", "capital advisory"],
  private_equity: ["private equity", "buyout", "growth equity"],
  venture_capital: ["venture capital", " vc "],
  private_credit: ["private credit", "direct lending"],
  real_estate: ["real estate"],
  hedge_fund: ["hedge fund", "long/short", "macro fund"],
  sales_trading: ["sales and trading", "sales & trading", "markets analyst", "trading desk", "sales & trading"],
  /**
   * "equity research" is deliberately NOT here.
   *
   * It was, and it made seven live postings wealth management: Morgan
   * Stanley's "2027 Equity Research Summer Analyst Program" in Singapore,
   * Hong Kong and London, Evercore's, and "2028 Equities: Equity Research
   * Summer Intern Program". Every one is SELL-SIDE research, which sits in a
   * bank's research or markets division and recruits students on the banking
   * track. None of them is wealth management.
   *
   * Removed rather than moved to investment_banking, which would have been
   * the same mistake pointing the other way: buy-side research is real, and a
   * hedge fund's "Equity Research Intern" is not a banking role either. With
   * no keyword, the phrase names no sector, and the posting falls through to
   * the SOURCE's registered sector - a bank's board answers investment
   * banking, a hedge fund's answers hedge fund, an asset manager's answers
   * asset & wealth management. Each is right, and none of them is a guess:
   * an admin registered that source under that sector.
   */
  asset_wealth_management: ["asset management", "wealth management", "portfolio management"],
  commercial_banking: ["commercial banking", "corporate banking", "middle market banking"],
  insurance: ["insurance", "actuarial"],
  fintech: ["fintech", "financial technology"],
  market_infrastructure: ["market infrastructure", "clearing house", "exchange operations"],
  /**
   * "consultant" as well as "consulting".
   *
   * The firms name the ROLE, not the practice: Bain posts "Associate
   * Consultant Intern", and neither that nor "Consultant Intern" contains the
   * word "consulting". Found by probing every industry with its own real
   * title conventions - the posting was read as relevant with no sector, and
   * a sector is required for auto-approval, so every consulting internship
   * would have gone to a human for want of six letters.
   *
   * "business analyst" is deliberately NOT here despite being McKinsey's own
   * title. It is one of the commonest job titles in any industry, and this
   * list is first-match-wins across all fourteen - a fintech's "Business
   * Analyst Intern" would silently become consulting.
   */
  consulting: ["consulting", "consultant", "advisory services"],
  other_finance: [],
};

/**
 * Which industry a piece of text names, by the same rules classifyListing uses.
 *
 * Exported because the rule now has to be applied somewhere else and must not
 * be written twice: opening-history.ts reads ARCHIVED careers pages and needs
 * to say which industry each internship title on them belongs to, so that a
 * firm running an investment banking programme and a real estate one gets an
 * opening window for each rather than one blurred across both.
 *
 * Same precedence as the classifier - first match in SECTOR_KEYWORDS order
 * wins - so a title cannot be filed under one industry here and another
 * there.
 */
export function sectorForText(
  text: string,
): { category: FirmProgramCategory; matched: string } | null {
  const haystack = text.toLowerCase();
  for (const [category, keywords] of Object.entries(SECTOR_KEYWORDS) as [
    FirmProgramCategory,
    string[],
  ][]) {
    const hit = findMatch(haystack, keywords);
    if (hit) return { category, matched: hit };
  }
  return null;
}

// Auto-approve requires all of: a clean relevance match, a recognized
// sector, an extracted recruiting cycle, AND no exclusion hit. Anything
// short of that goes to the human queue rather than guessing.
const AUTO_APPROVE_THRESHOLD = 0.8;

/**
 * Phrase match on WORD BOUNDARIES, not substrings.
 *
 * A plain `haystack.includes("intern")` matches "International", "Internal"
 * and "internally", and that is not hypothetical: it is why the pipeline held
 * a Bank of America "listing" titled "International", an Alantra one titled
 * "Bylaws, Regulations and other Internal rules", and a BDO one titled
 * "International Tax" - all three classified relevant, none of them an
 * internship. A false positive here is worse than a miss, because it reaches a
 * student as a real opportunity.
 *
 * Boundaries also fix the sector list's " vc " entry, which previously needed
 * literal surrounding spaces and so missed "VC," and "(VC)".
 */
const boundaryCache = new Map<string, RegExp>();

function phrasePattern(phrase: string): RegExp {
  const cached = boundaryCache.get(phrase);
  if (cached) return cached;
  const trimmed = phrase.trim();
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // \b means nothing at a non-word edge (e.g. "&"), so only anchor the sides
  // that actually begin or end with a word character.
  const left = /^\w/.test(trimmed) ? "\\b" : "";
  // A trailing "s" has to be allowed inside the boundary, or "Analyst Interns"
  // and "Summer Analyst Programs" stop matching - the boundary would sit
  // between "intern" and "s". "internship" is its own phrase, so "intern" +
  // optional s still cannot reach "international".
  const right = /\w$/.test(trimmed) ? "s?\\b" : "";
  const re = new RegExp(`${left}${escaped}${right}`, "i");
  boundaryCache.set(phrase, re);
  return re;
}

function findMatch(haystack: string, phrases: string[]): string | null {
  return phrases.find((p) => phrasePattern(p).test(haystack)) ?? null;
}

/**
 * "Class of 2028" is a graduating class, not a summer.
 *
 * These are two different facts and the pipeline has a field for each:
 * `recruitingCycle` is WHICH SUMMER the internship runs, `eligibility` is WHO
 * the firm will accept. Conflating them shows a posting to the wrong year of
 * student, which is the one thing the cycle filter exists to prevent.
 *
 * It was conflated, because "class" is one of CYCLE_WORDS - reasonably, since
 * "Summer Analyst Class 2027" really does name a cycle. But "class OF 2028"
 * never does. Measured on Supabase, 20 September 2026, among published
 * postings:
 *
 *   "Summer 2027 Financial Analyst (Class of 2028), Portfolio Valuation"
 *      -> stored as programYear 2028
 *   "Summer 2027 Financial Analyst (Class of 2028), Corporate Valuation"
 *      -> stored as programYear 2028
 *
 * Both titles say "Summer 2027" in words, and the class year beat it. Those
 * are Summer 2027 internships filed under Summer 2028, where the students who
 * could actually apply will never see them and a year of students who cannot
 * will.
 *
 * So class years are masked out before any cycle rule reads the text. They
 * are not discarded - eligibility.ts reads the same phrase for grad years,
 * and `cycleFromClassYear` below turns one into a cycle when nothing else
 * states it.
 */
export function maskClassYears(text: string): string {
  // Same phrase eligibility.ts matches on, so the two cannot disagree about
  // what a class year looks like.
  return text.replace(
    /\bclass(?:es)?\s+of\s+20\d{2}(?:\s*(?:,|,?\s*(?:and|or|through|-|–|to)\s*)\s*20\d{2})*/gi,
    " ",
  );
}

/**
 * The summer a stated graduating class recruits for.
 *
 * Used only when the posting states no cycle of its own. "Class of 2028
 * Equity Capital Markets Research Intern" names no summer anywhere - but a
 * student graduating in 2028 interns in the summer of 2027, and that is not
 * an inference this file is making up: `targetProgramYear` in
 * internship-year.ts is the same rule the app already uses to decide which
 * cycle to show a student, and its comment exists precisely so the offset has
 * one definition.
 *
 * So this reads the firm's own statement through the app's own mapping. The
 * EARLIEST class named wins: a posting open to the classes of 2028 and 2029
 * is recruiting now, for the nearer summer.
 */
export function cycleFromClassYear(text: string): number | null {
  const years: number[] = [];
  for (const m of text.matchAll(
    /\bclass(?:es)?\s+of\s+((?:20\d{2})(?:\s*(?:,|,?\s*(?:and|or|through|-|–|to)\s*)\s*20\d{2})*)/gi,
  )) {
    for (const y of m[1].matchAll(/20\d{2}/g)) years.push(Number(y[0]));
  }
  if (!years.length) return null;
  return Math.min(...years) - 1;
}

/**
 * The words that make a nearby year a RECRUITING cycle rather than a number.
 *
 * At module scope because two rules now read it - the windowed search over a
 * description, and `cycleFromTitle` - and a vocabulary that drifts between
 * them would mean a title and its own description disagreeing about whether
 * the posting names a cycle at all.
 */
/**
 * The words that make a year in a title a RECRUITING CYCLE rather than a date.
 *
 * `stage`, `alternance` and `co-op` were missing, and the relevance rules knew
 * all three - which is the exact failure this file's French-tax comment warns
 * about: "the shape of the risk in adding vocabulary to one list and not the
 * other. A phrase list that can see a posting but not classify it produces a
 * confident wrong answer instead of a silent miss."
 *
 * Here it produced the silent miss. Measured 11 October 2026: these titles are
 * `relevant: true` with the year printed in them and no cycle extracted, so
 * they could never auto-approve and sat in the review queue -
 *
 *   "Stage Infrastructure Debt Advisory - Global Advisory - Janvier 2027"
 *   "Alternance - M&A Small & Mid Cap - Transaction R & Co - Janvier 2027"
 *   "Parametric - 2027 AI-Enabled Technical Co-op (Alpharetta, GA)"
 *
 * `co-?op` is written with the optional hyphen but no bare `coop`, because
 * `\bcoop` also matches "cooperative" - a word that appears in plenty of real
 * bank titles and names no cycle at all.
 *
 * `stagiair` is spelled out with its inflections rather than left to `stage`,
 * which looks like it should cover it and does not: "stagiair" contains no
 * "stage", and both uses of this list anchor with \b, so `stage` cannot reach
 * inside it either. Measured on Egeria's "Stagiair Private Equity June/July
 * 2027" - a real internship whose year is right there in the title, which
 * stated its cycle and had none derived.
 *
 * Measured against the live listings on 13 October 2026, counting relevant
 * listings that carry a 20xx year and no derived cycle: `stagiair` rescues 10,
 * all of them Rothschild & Co's French internships - "Stage d'Analyste en
 * Private Equity ... Juillet 2027" and the like, whose bodies say "stagiaire".
 * Those are exactly what this pipeline is for. The other candidates tried -
 * becario, practicas, tirocinio, estagio, praktyki, praktikant - rescue none.
 *
 * `praktikum` IS DELIBERATELY ABSENT, and it is the reason this comment
 * records what was counted rather than just how many. It rescued exactly one
 * listing: Deutsche Bank's "Dein Schul-, FOS- und Berufsorientierungs-
 * Praktikum" - a careers-orientation placement for SCHOOL pupils, FOS being a
 * German vocational secondary school. Reading its year would have cleared the
 * last thing standing between a school taster week and an undergraduate's
 * internship list. A count of 1 looked harmless; the listing behind the count
 * was the whole problem.
 *
 * So the rule for growing this list is to read every listing a candidate word
 * would rescue, not to check that the number is small. A word here lets a
 * nearby year become a cycle, and a cycle is the last gate before publishing.
 *
 * THE UNDERGRADUATE YEAR WORDS ARE HERE BECAUSE THEY ARE IN
 * TITLE_INTERNSHIP_SHAPES, and that pairing is the point. Adding a word to the
 * relevance vocabulary without adding it here leaves a listing relevant and
 * YEARLESS, and both failures that produces are worse than the original
 * rejection:
 *
 *   Bracebridge Capital  "2027 Sophomore Winternship"
 *       relevant, cycle null - held back for "no recruiting-cycle year found",
 *       with the year sitting in its own title.
 *   Weiss Asset Management  "2027 Underclassmen Fellowship"
 *       relevant, cycle 2028, needsHumanReview FALSE - so it would publish,
 *       with the wrong year. No stated cycle could be read, so the
 *       graduating-class fallback won and mapped "Classes of 2029 and 2030" to
 *       a 2028 summer. The programme is a two-day event in January 2027, which
 *       its title and its body both say.
 *
 * Showing a 2027 programme as 2028 puts it in front of the wrong year of
 * student, which is the one thing the cycle filter exists to prevent. So a
 * word added to the shapes list is added here in the same change.
 */
const CYCLE_WORDS =
  "summer|spring|autumn|winter|class|program|programme|analyst|associate|intern|internship|insight|off-cycle|off cycle|placement|stage|stagiair(?:e|s|es)?|alternance|co-op|co op|underclassm[ae]n|sophomore|freshman|winternship";

function extractRecruitingCycle(haystack: string, title?: string): number | null {
  // The title is asked first, and answers for itself - see cycleFromTitle.
  if (title) {
    const fromTitle = cycleFromTitle(title);
    if (fromTitle !== null) return fromTitle;
  }
  // A graduating class is not a summer - see maskClassYears.
  haystack = maskClassYears(haystack);

  // "Summer 2028", "Class of 2028", "2028 Summer Analyst Program" - a 4-digit
  // year within a few words of a recruiting-cycle word, not just any number
  // on the page (comp figures, addresses, etc. would otherwise match).
  // The gap either side was 20 characters and that was too tight by literally
  // one: Evercore's "2027 Strategic Advisory: Summer Associate Program" puts
  // 21 characters between the year and "Summer", so the cycle came back null,
  // the listing lost the 0.2 that carries it over the auto-approve line, and a
  // real banking internship sat in the review queue unseen. 40 still requires a
  // cycle word in the same breath as the year, which is what stops this
  // matching a street address or a comp figure.
  // "insight", "spring week", "intern(ship)" and "off-cycle" join the cycle
  // words because they name programmes whose titles carry a year but no
  // "summer": "Spring Insight Week 2027" and "2027 January Off-Cycle Analyst"
  // both lost their cycle and went to a human for want of a keyword.
  const re = new RegExp(
    `\\b(20\\d{2})\\b[^.]{0,40}\\b(${CYCLE_WORDS})\\b|\\b(${CYCLE_WORDS})\\b[^.]{0,40}\\b(20\\d{2})\\b`,
    "i",
  );
  const match = re.exec(haystack);
  if (!match) return null;
  const year = match[1] ?? match[4];
  return year ? Number(year) : null;
}

/**
 * The year a TITLE states, however many words the firm puts in the middle.
 *
 * The windowed search above is the right rule for a description, which is
 * prose: a year forty characters from "programme" is plausibly that
 * programme's year, and one four hundred characters away is a copyright line.
 * A title is not prose. It is short, curated, and written by the firm to
 * identify one posting, so a year and a cycle word in the SAME title belong
 * to each other no matter how much routing the bank staples between them.
 *
 * The window was already widened once, 20 to 40, because Evercore's "2027
 * Strategic Advisory: Summer Associate Program" missed by a single character.
 * Widening it again would be the same fix in the same place for the third
 * time, and it would apply to descriptions too, where the distance is the
 * only thing keeping a copyright year out.
 *
 * Measured against Supabase on 20 September 2026, this is eight live postings
 * whose title OPENS with the year, four of them already auto-approved and
 * unpublishable for want of the cycle they plainly state:
 *
 *   "2027 - Global Markets - Rates Sales  - 6 Month Off Cycle Internship"
 *   "2027 - Investment Banking - Coverage & Advisory  - Summer Internship"
 *   "2027 Financial Resources & Strategy Industrial Placement Internship"
 *   "2027 Investment Banking and Global Capital Markets Strats Summer Associate"
 *
 * Each puts 43 to 46 characters between the year and its cycle word - missing
 * a 40-character window by three. This is a STATED year, read off the firm's
 * own title, so nothing here is derived or inferred.
 *
 * Still requires a cycle word to be present. A year alone in a title is not a
 * recruiting cycle: "2026 Boston Career Forum Recruitment Event", "2026 Women
 * Who Lead: Quantitative Finance" and "2026 Cohort: CEO in Residence" are all
 * live titles carrying a year and no programme, and all three stay null.
 */
function cycleFromTitle(title: string): number | null {
  const text = maskClassYears(title.toLowerCase());
  const year = /\b(20\d{2})\b/.exec(text);
  if (!year) return null;
  if (!new RegExp(`\\b(${CYCLE_WORDS})\\b`, "i").test(text)) return null;
  return Number(year[1]);
}


/**
 * The cycle a posting implies but never writes down.
 *
 * Auto-approval requires a recruiting cycle, and plenty of genuine postings
 * never state one in words - 38 Oracle listings sat in review reading
 * "relevant with a sector, but no recruiting-cycle year found". The year is
 * usually there; it is just in a date rather than a sentence.
 *
 * DERIVED, AND SAID SO. Everything else in this pipeline refuses to state what
 * a source did not - `publishedAt` is documented as never inferred. This is the
 * deliberate exception, agreed 19 September 2026, and it earns the exception by
 * being reported as `derived` rather than laundered into a stated fact, so a
 * reviewer can see where the year came from and overrule it.
 *
 * Deterministic only. An LLM pass for the residual lives in a separate script,
 * because a normal crawl spends nothing and that property is worth keeping.
 */
export function deriveRecruitingCycle(listing: {
  deadlineAt?: string | null;
  publishedAt?: string | null;
}): { year: number; basis: string } | null {
  /**
   * An application deadline is the strongest signal there is.
   *
   * Firms open applications the year BEFORE the summer they are recruiting
   * for - a deadline in November 2026 is for summer 2027. Deadlines from
   * January to June belong to that same calendar year's cycle, because those
   * are the late and off-cycle rounds.
   */
  if (listing.deadlineAt) {
    const deadline = new Date(listing.deadlineAt);
    if (!Number.isNaN(deadline.getTime())) {
      const month = deadline.getUTCMonth(); // 0-11
      const year = deadline.getUTCFullYear();
      // July onwards recruits for the following summer.
      const cycle = month >= 6 ? year + 1 : year;
      return { year: cycle, basis: `derived from the stated application deadline (${listing.deadlineAt.slice(0, 10)})` };
    }
  }

  /**
   * Failing that, when the SOURCE stated a publication date.
   *
   * Weaker, and deliberately second: a board can republish an old posting, and
   * a posting put up in August is for next summer while the same words in
   * February are for this one. Same boundary as above, for the same reason.
   */
  if (listing.publishedAt) {
    const published = new Date(listing.publishedAt);
    if (!Number.isNaN(published.getTime())) {
      const month = published.getUTCMonth();
      const year = published.getUTCFullYear();
      const cycle = month >= 6 ? year + 1 : year;
      return { year: cycle, basis: `derived from the stated posting date (${listing.publishedAt.slice(0, 10)})` };
    }
  }

  return null;
}


/**
 * One spelling of a title, for matching only.
 *
 * Every rule in this file is a regex over a title, and regexes are exactly
 * what punctuation breaks. Measured by the robustness suite, which puts each
 * labelled case through the formatting real boards actually emit:
 *
 *   en-dash for hyphen     "2027 January Off-Cycle Analyst" -> rejected
 *   doubled spaces         three real internships -> rejected
 *   non-breaking spaces    "2027 Software Engineer Summer Internship"
 *                          -> RELEVANT, a technology role reaching students
 *
 * That last one is the reason this is a correctness fix rather than tidiness.
 * A separator class like `[\s-]` matches ONE character, so a title joined
 * with two spaces misses its phrase, and a title using U+2013 misses every
 * rule written with a plain hyphen. Both shapes are already in the corpus -
 * "2027 Human Resources Summer Analyst Program - New York" is an en-dash, and
 * doubled spaces appear wherever a scraper joined two DOM nodes.
 *
 * Applied to the text the rules READ, never to the text that is stored or
 * quoted back: evidence still shows the title as the source wrote it.
 */
function normalizeForMatching(value: string): string {
  return value
    /**
     * "Co-Op City" is a place, not a programme.
     *
     * Co-Op City is a Bronx neighbourhood, and `TITLE_INTERNSHIP_PHRASES`
     * carries both "co-op" and "coop" because they are how several firms
     * recruit sophomores. The collision made "Teller Part-Time (20 Hours) -
     * Co-Op City Branch" - an hourly retail bank job - classify as a relevant
     * internship, and 2 such rows are in the corpus, both judged relevant.
     *
     * Neutralised here rather than by an exclusion rule, because the title
     * does not name an off-limits profession; the phrase match is simply
     * reading a street sign. Masked the same way class years are, and for the
     * same reason: the stored and quoted title is untouched, so evidence
     * still shows what the firm wrote.
     */
    .replace(/\bco-?op\s+city\b/gi, "PLACENAME")
    // Every dash variant, including the non-breaking hyphen, becomes "-".
    .replace(/[\u2010-\u2015\u2212\u2043\uFE58\uFE63\uFF0D]/g, "-")
    // Every space variant, including nbsp and the narrow/zero-width ones.
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    // Runs of whitespace collapse, so a doubled space cannot break a phrase.
    .replace(/\s+/g, " ")
    .trim();
}

  /**
   * MBA "Summer Associate" programmes, which undergraduates cannot apply to.
   *
   * In banking the two words carry the degree: Summer ANALYST is the
   * undergraduate seat, Summer ASSOCIATE is the MBA one. The hard rule further
   * down catches titles that say "MBA" outright - Morgan Stanley's did - but
   * most banks never print the word, because in their own house style the
   * title already says it. 69 such postings were live on 21 September 2026,
   * from Bank of America, Evercore and Guggenheim among others, every one of
   * them reachable by a student graduating in 2029.
   *
   * WHY BOTH SIGNALS, AND NOT EITHER ALONE
   * --------------------------------------
   * Title alone is wrong. Consulting firms use "associate" for the
   * undergraduate grade - Berkeley Research Group posts "2027 Summer Associate
   * (Intern)" - so excluding on the phrase would throw away real openings.
   *
   * Description alone is worse. Banks describe their analyst and associate
   * programmes in one shared body, so the word MBA appears in postings for
   * roles undergraduates CAN take: six were checked, including Morgan
   * Stanley's "2027 Japan Summer Analyst Program" and Nomura's "2027
   * Quantitative Risk Management Summer Analyst". Excluding on the description
   * would have dropped all of them.
   *
   * The conjunction is what is actually diagnostic: the title names the
   * associate seat AND the body states a graduate requirement. Measured over
   * the 69 live postings, that selects 50 and leaves the 19 that state no
   * requirement - which stay in, because a guess in this direction costs a
   * student a real opening.
   *
   * "summer analyst" in the title vetoes it outright. A posting advertising
   * both seats is one an undergraduate can apply to.
   */
export function graduateAssociateReason(
  title: string,
  division?: string | null,
  description?: string | null,
): string | null {
  const titleScope = `${title} ${division ?? ""}`;
  const body = `${titleScope} ${description ?? ""}`;
  if (!/\bsummer[\s-]associate\b/i.test(titleScope)) return null;
  if (/\bsummer[\s-]analyst\b/i.test(titleScope)) return null;
  if (
    !/\bmba\b|master['\u2019]?s degree|graduate degree|currently enrolled in[^.]{0,40}(mba|master)/i.test(
      body,
    )
  ) {
    return null;
  }
  return "MBA summer associate programme - Offerly is for undergraduates";
}

export function classifyListing(
  rawListing: NormalizedListing,
  /**
   * The sector the SOURCE is registered under, used only when the listing's own
   * words do not name one.
   *
   * The source registry already knows Evercore's board is investment banking;
   * the classifier was made to rediscover that from each title and, whenever a
   * firm names its groups in its own house style, failed and dropped the
   * posting into the review queue. Falling back to what we already know turns
   * a silent miss into a correct answer, and it is never a guess: an admin
   * registered that source under that sector.
   */
  fallbackSector?: FirmProgramCategory | null,
  /**
   * A programme year established outside the deterministic extractor, with a
   * quote to back it.
   *
   * WHY IT IS AN INPUT AND NOT A PATCH. `scripts/review-agent.ts` recovers a
   * missing year by asking a model to find one and verifying its quote
   * verbatim against the page. It then used to write the year onto the
   * classification this function had already returned - and that does not
   * work, because `needsHumanReview` is the negation of a five-part
   * conjunction that INCLUDES having a year. Supplying the year afterwards
   * left `needsHumanReview` true, so `publishableWithoutReview` stayed false
   * and the recovery could never complete. Measured on Egeria's "Stagiair
   * Private Equity June/July 2027": the model found 2027 and quoted the title
   * it came from, and the listing still could not be released.
   *
   * Passing it in instead means the whole conjunction is recomputed with the
   * year known - including the three conditions the reason chain never
   * reached while the year was missing (confidence, verifiability, dead
   * years). So a listing released this way cleared exactly the same gate as
   * one whose year was printed on the page, which is the property that lets a
   * model contribute at all: it supplies a fact, and this function alone
   * decides.
   */
  knownCycle?: number | null,
): Classification {
  /**
   * The listing as the RULES see it - one spelling of every separator.
   *
   * The original is kept for evidence and for everything downstream, so a
   * reviewer reads the title the firm actually published.
   */
  const listing: NormalizedListing = {
    ...rawListing,
    title: normalizeForMatching(rawListing.title),
    division: rawListing.division ? normalizeForMatching(rawListing.division) : rawListing.division,
    descriptionRaw: normalizeForMatching(rawListing.descriptionRaw ?? ""),
  };

  const haystack = `${listing.title} ${listing.division ?? ""} ${listing.descriptionRaw}`.toLowerCase();
  // Hoisted: the staleness test below needs it, and every rule in this file is
  // scoped to the title for the same reason - what a job IS lives in its title.
  const titleScope = `${listing.title} ${listing.division ?? ""}`.toLowerCase();
  const evidence: string[] = [];

  // Read once, up front: everything below reports them, and the requirements
  // section is also the best text to read eligibility out of.
  const quality = assessPostingQuality(listing);
  const requirementsRaw = extractRequirements(listing.descriptionRaw);
  const requirementsList = splitRequirements(requirementsRaw);

  /**
   * Is this a posting at all - asked BEFORE is it a relevant one.
   *
   * The order is the whole point. The old classifier went straight to "does
   * this say internship", so a filter control reading "Clear Region EMEA (22
   * Results) AEJ..." and a marketing sentence beginning "Our internship
   * opportunities are your steppingstone..." both matched, both scored above
   * the auto-approve line, and both were one script away from students.
   *
   * Returned as not-relevant AND not-for-review: unlike an exclusion, which an
   * admin might reasonably overturn, there is no posting here to overturn it
   * into. Sending these to a human would bury the queue in page furniture.
   */
  if (!quality.ok) {
    return {
      relevant: false,
      sector: null,
      subsector: null,
      recruitingCycle: null,
      confidence: 0.95,
      matchedEvidence: quality.reasons.map((r) => `not a posting: ${r}`),
      /**
       * THE REASON GOES IN THE FIELD THAT IS READ.
       *
       * This computed the cause, put it in `matchedEvidence`, and left this
       * null. Measured 12 October 2026: 10,473 of 20,693 rejected rows had no
       * `reasonForUncertainty`, 9,138 of them written in two days - and every
       * recovery path selects on THIS field, not on the evidence array:
       * `adjudicate-rejections.ts` by substring, `classifier-report.ts` the
       * same, `review-agent.ts` through its cohort filter. So the rows this
       * branch produced were invisible to every mechanism built to rescue
       * them, which makes "a rejection is recoverable" untrue for half of
       * them.
       *
       * The decision is unchanged. Only the explanation moves.
       */
      reasonForUncertainty: `not a posting: ${quality.reasons.join("; ") || "failed the posting-quality gate"}`,
      needsHumanReview: false,
      isPosting: false,
      qualityIssues: quality.reasons,
      verifiable: quality.verifiable,
      staleCycle: false,
      eligibility: { gradYears: [], level: null, basis: "unknown", evidence: [] },
      requirementsRaw,
      requirementsList,
    };
  }

  /**
   * A cycle that has already happened.
   *
   * Deutsche Bank's marketing sentence was published with
   * `recruitingCycle: 2023` - the year came from a copyright line, not from a
   * programme. A past summer cannot be applied to, so this is never relevant,
   * and it is never worth a human's time either.
   */
  /**
   * The cycle used to JUDGE staleness comes from the title first.
   *
   * `extractRecruitingCycle` returns the first year sitting within 40
   * characters of a recruiting word, anywhere in title + division +
   * description. That is the right rule for reporting a cycle and the wrong
   * one for throwing a posting away, because a description is full of years
   * that are not cycles: "our internship program began in 2015" satisfies the
   * pattern exactly. A title year usually wins by being earlier in the
   * string, so this only bites postings whose title carries no year - Baird's
   * "Internship - Marketing (Year-Round)" is a real example - and those are
   * precisely the ones with no second chance.
   *
   * So: trust the title, and treat a description-only year as too weak to
   * reject on. The reported cycle is unchanged; only the discard is narrowed.
   */
  const titleCycle = extractRecruitingCycle(titleScope);
  const cycleForStaleness = titleCycle ?? extractRecruitingCycle(haystack);
  if (titleCycle !== null && isStaleCycle(titleCycle)) {
    const { min, max } = liveCycleRange();
    return {
      relevant: false,
      sector: null,
      subsector: null,
      recruitingCycle: cycleForStaleness,
      confidence: 0.95,
      matchedEvidence: [
        `cycle ${cycleForStaleness} is outside the live range ${min}-${max}`,
      ],
      // Stated here too, not only in the evidence - see the note on the
      // posting-quality branch above.
      reasonForUncertainty: `cycle ${cycleForStaleness} is outside the live range ${min}-${max}`,
      /**
       * Reviewable, where it used to be silently dropped.
       *
       * Every other rejection path in this file sets this true so an admin can
       * overturn a wrong call - and this one is driven by the least reliable
       * extraction in the file, a regex looking for a year near a recruiting
       * word. A posting that is genuinely last year's costs a reviewer two
       * seconds; a live internship whose title year was misread costs a
       * student the opening, and left no trace anywhere a human looks.
       */
      needsHumanReview: true,
      isPosting: true,
      qualityIssues: [`recruiting cycle ${cycleForStaleness} is not a live cycle`],
      verifiable: quality.verifiable,
      staleCycle: true,
      eligibility: { gradYears: [], level: null, basis: "unknown", evidence: [] },
      requirementsRaw,
      requirementsList,
    };
  }

  /**
   * Exclusions are judged on the TITLE, never the description.
   *
   * EXCLUSION_RULES is documented above as a list of titles that read as an
   * internship but are not one - and it has to be applied that way, because
   * every rule in it describes what the ROLE IS, which only the title states.
   * Run against the full description it produces false exclusions on exactly
   * the postings that matter most: William Blair's real "London Investment
   * Banking Summer Analyst, Summer 2027 Programme" was thrown out because its
   * description says the intern will work alongside "senior" bankers. Nearly
   * every genuine banking internship description mentions a senior title, a
   * full-time offer, or an MBA programme somewhere, so this rule silently
   * discarded real openings while keeping the junk with short titles.
   *
   * A relevance phrase in the title also outranks an exclusion: a posting
   * literally called "Summer Analyst" is a summer analyst role, whatever else
   * the title happens to mention.
   */
  const titleSaysInternship = findMatch(titleScope, TITLE_INTERNSHIP_PHRASES) !== null;
  // Checked first and unconditionally - see OFF_PROFESSION_RULES for why
  // "it says Summer Analyst" must not rescue one of these.
  const offProfession = offProfessionReason(listing.title, listing.division, fallbackSector ?? null);
  /**
   * Technology roles are wrong-profession, not wrong-seniority.
   *
   * They were in EXCLUSION_RULES, where "it says Summer Analyst" overturns the
   * rule - so Lazard's "2027 Software Engineer Summer Internship" auto-approved
   * and reached students as a banking opening. It is a real, open internship;
   * it is simply not one this product covers, which is the same distinction
   * OFF_PROFESSION_RULES already draws for tax and audit.
   *
   * Scoped to the title like every other rule here: a banking posting whose
   * description mentions building models in Python is still a banking posting.
   */
  /**
   * Widened after re-classifying the corpus, which found three of these
   * reaching students.
   *
   * "Software Developer, Winter 2027 (Internship)" is the embarrassing one -
   * plain English, and the rule only said "software engineer". The other two
   * are French: "Stage H/F - Ingenieur IA Multi-Equipes" and "Stage H/F - IA
   * Manager", because every rule here was written against English titles and
   * this corpus is not only English.
   *
   * "ingenieur" is deliberately NOT matched on its own. A Financial Engineer
   * is a quant finance role squarely in scope, and this board carries
   * "Internship - Financial Engineer - Corporate & Investment banking". Only
   * the technology pairings are excluded.
   */
  const offTechnology = /\b(software (engineer(ing)?|developer|development)|swe|devops|site reliability|data engineer|full[- ]stack|back[- ]end|front[- ]end|machine learning engineer|platform engineer|d[eé]veloppeur|ing[eé]nieur\s+(ia|logiciel|informatique|donn[eé]es|d[eé]veloppement)|\b(ia|ai)\s+(manager|engineer|ing[eé]nieur|lead)\b)\b/i.test(
    titleScope,
  )
    ? "technology role, not finance"
    : null;

  /**
   * A full-time programme is not an internship, whatever else the title says.
   *
   * This has to outrank the "a relevance phrase in the title settles it" rule,
   * because the two collide head-on: Evercore posts "2027 Strategic Advisory:
   * Mergers & Acquisitions Full Time Analyst Program - Richmond" and "Full Time
   * Associate Program - New York". Both contain "analyst program" / "associate
   * program", both were auto-approved, and both are graduate jobs that a
   * student cannot apply to as an intern.
   */
  const fullTimeProgramme = /\bfull[- ]?time\b/i.test(titleScope)
    ? "a full-time programme, not an internship"
    : null;

  const graduateAssociate = graduateAssociateReason(
    listing.title,
    listing.division,
    listing.descriptionRaw,
  );

  /**
   * Recruiting EVENTS, which these boards publish alongside their openings.
   *
   * Evercore's TalentLink board carries "2028 Summer Analyst Evercore
   * Networking Reception - University of Southern California" and "2028
   * Evercore Summer Analyst Chicago - Industrials Coffee Chats". Both say
   * "Summer Analyst", both auto-approved, and neither is a job - they are
   * invitations to meet the firm. Showing one to a student as an opening
   * wastes the thing they came here for.
   *
   * Worth keeping SOMEWHERE eventually - a coffee chat is genuinely useful to
   * a student - but as an event, not as an internship posting.
   */
  // Plurals matter here: the board publishes "Coffee Chats", and a pattern
  // anchored on the singular misses every one of them.
  /**
   * The source's own structured metadata saying this is an event.
   *
   * Checked against the DESCRIPTION, which every other rule here deliberately
   * avoids - and the exception is justified because this is not prose. The
   * TalentLink feed emits "Event Date:" and "Registration Deadline:" on events
   * and "Application Deadline:" on vacancies. That is the source telling us
   * what the row is, in a fixed format, and it is far more reliable than
   * guessing from a title: Evercore's "2028 Summer Analyst Intro to Evercore -
   * Duke" and "...- Cornell" are campus events whose titles read exactly like
   * internships and share no keyword that would separate them.
   */
  const structuredEvent = /\b(Event Date|Registration Deadline)\s*:/i.test(listing.descriptionRaw)
    ? "the source labels this an event (Event Date / Registration Deadline), not a vacancy"
    : null;

  const recruitingEvent = /\b(networking (receptions?|events?|sessions?)|coffee chats?|info(rmation)? sessions?|open (days?|house)|career fairs?|meet[- ]the[- ]|firesides?|webinars?|panel discussions?|insight (evenings?|days?)|alumni receptions?|recruiting events?)\b/i.test(
    titleScope,
  )
    ? "a recruiting event, not a job posting"
    : null;

  const exclusion = offProfession
    ? { reason: offProfession }
    : offTechnology
      ? { reason: offTechnology }
      : fullTimeProgramme
        ? { reason: fullTimeProgramme }
        : graduateAssociate
          ? { reason: graduateAssociate }
          : structuredEvent
          ? { reason: structuredEvent }
          : recruitingEvent
            ? { reason: recruitingEvent }
            : // Hard rules are consulted whatever the title says; the rest
              // still yield to an explicit internship phrase.
              EXCLUSION_RULES.find(
                (r) => (r.hard || !titleSaysInternship) && r.pattern.test(titleScope),
              );
  if (exclusion) {
    return {
      relevant: false,
      sector: null,
      subsector: null,
      recruitingCycle: extractRecruitingCycle(haystack, listing.title),
      confidence: 0.9,
      matchedEvidence: [`excluded: ${exclusion.reason}`],
      // Stated here too - see the note on the posting-quality branch above.
      // This one matters most for recovery: an exclusion is the rejection an
      // admin is most likely to want to overturn, and it was the least
      // findable.
      reasonForUncertainty: `excluded: ${exclusion.reason}`,
      needsHumanReview: true, // never silently drop - an admin can overturn a wrong exclusion
      isPosting: true,
      qualityIssues: [],
      verifiable: quality.verifiable,
      staleCycle: false,
      eligibility: { gradYears: [], level: null, basis: "unknown", evidence: [] },
      requirementsRaw,
      requirementsList,
    };
  }

  /**
   * Relevance is decided on the TITLE, not the description.
   *
   * Matching the whole posting is what let 223 full-time roles through in one
   * run. Nearly every banking job description mentions the firm's internship
   * programme somewhere - "many of our analysts join us after completing our
   * Summer Analyst Program" - so "Investment Banking Associate - Technology"
   * matched an internship phrase and went to a human to be rejected by hand.
   * Sixteen William Blair associate roles in a single board did exactly that.
   *
   * What a job IS lives in its title, the same reasoning EXCLUSION_RULES and
   * OFF_PROFESSION_RULES are already scoped by. The phrase list below is wider
   * than RELEVANCE_PHRASES because a title carries less context: "2027 January
   * Off-Cycle Analyst" is an internship and never says "intern", while
   * "IB Analyst - Real Estate" is a full-time job whose title differs only by
   * what surrounds the word.
   */
  const relevanceHit =
    findMatch(titleScope, TITLE_INTERNSHIP_PHRASES) ??
    // Then the non-adjacent shapes - see TITLE_INTERNSHIP_SHAPES.
    (TITLE_INTERNSHIP_SHAPES.find((re) => re.test(titleScope))
      ? titleScope.match(TITLE_INTERNSHIP_SHAPES.find((re) => re.test(titleScope))!)?.[0] ?? null
      : null);
  if (relevanceHit) {
    evidence.push(`title matched "${relevanceHit}"`);
  } else {
    /**
     * Record the NON-match as evidence too.
     *
     * This is the single most common reason a listing is rejected - 1,182 of
     * 2,164 on 19 September 2026 - and until now it left no trace in
     * `matchedEvidence`. The reason existed, in `reasonForUncertainty`, but
     * nothing a reviewer reads shows that field, so more than half of all
     * rejections looked unexplained. An audit of "why was this dropped" came
     * back empty for the majority of cases, which is how 42 French-language
     * internships sat rejected without anyone noticing a pattern.
     *
     * A rejection that cannot say why is indistinguishable from a bug.
     */
    evidence.push(
      `not an internship: the title matched no internship phrase (checked ${TITLE_INTERNSHIP_PHRASES.length} phrases against "${listing.title.slice(0, 80)}")`,
    );
  }

  // Through sectorForText so this rule has exactly one implementation - see
  // its comment on why opening-history.ts needs the same answer.
  /**
   * The TITLE decides the sector; the description only breaks a tie.
   *
   * `sectorForText` returns the first category in SECTOR_KEYWORDS order whose
   * keyword appears anywhere in the text, and investment_banking is first. Run
   * over title + division + DESCRIPTION, that means any posting whose body
   * mentions "M&A" or "strategic advisory" is banking - and every bank's
   * boilerplate mentions both, on every posting it publishes, whatever the
   * job is.
   *
   * Measured on Supabase, 20 September 2026: of 764 relevant listings, 31 are
   * filed under a sector their own title contradicts, and most are already
   * published to students.
   *
   *   11  title says asset_wealth_management  -> stored investment_banking
   *    5  title says consulting               -> stored insurance
   *    4  title says sales_trading            -> stored investment_banking
   *    3  title says commercial_banking       -> stored investment_banking
   *    2  title says private_credit           -> stored investment_banking
   *    2  title says private_equity           -> stored investment_banking
   *
   * "2028 Equities: Sales & Trading Summer Intern Program" and "2027 Private
   * Credit Investment Summer Internship Programme - London" are both live
   * under investment banking. A student filtering for either sector is shown
   * nothing while the posting sits one category over - which reads as the
   * crawler having no coverage there, and is really a labelling fault.
   *
   * This is the same reasoning the file already applies twice: "What a job IS
   * lives in its title, the same reasoning EXCLUSION_RULES and
   * OFF_PROFESSION_RULES are already scoped by." The description stays as the
   * fallback, because most titles name no sector at all - 458 of the 764 -
   * and for those the body is the only evidence there is.
   */
  const titleSectorHit = sectorForText(titleScope);
  const sectorHit = titleSectorHit ?? sectorForText(haystack);
  let sector: FirmProgramCategory | null = sectorHit?.category ?? null;
  if (sectorHit) {
    evidence.push(
      `sector keyword "${sectorHit.matched}" -> ${sectorHit.category}` +
        (titleSectorHit ? " (from the title)" : " (from the description)"),
    );
  }
  if (!sector && fallbackSector) {
    sector = fallbackSector;
    // Recorded as evidence like any other finding, so a reviewer can see the
    // sector came from the source registry rather than from the posting's own
    // words and can overrule it.
    evidence.push(`sector from source registry -> ${fallbackSector}`);
  }

  /**
   * A stale year found only in the description is not this posting's cycle.
   *
   * It no longer rejects the listing (see the staleness note above), and it
   * must not be published as the cycle either - auto-approval requires a
   * cycle, so passing "2015" through would publish a live internship stamped
   * with a dead year. Left null instead, which sends it to a human.
   */
  const haystackCycle = extractRecruitingCycle(haystack, listing.title);
  const statedCycle =
    haystackCycle !== null && isStaleCycle(haystackCycle) ? null : haystackCycle;
  // Only derive when the posting did not say. A stated year always wins - the
  // firm knows its own programme better than a date arithmetic does.
  /**
   * A stated graduating class, when nothing states a summer.
   *
   * Ranked BELOW a deadline and a posting date, because those are dates the
   * firm published about this posting, and above nothing at all. "Class of
   * 2028 Equity Capital Markets Research Intern" names no summer anywhere -
   * but the firm has said who it wants, and targetProgramYear is the app's
   * own rule for turning that into a cycle.
   *
   * Stale-checked like any other cycle: a class that graduated years ago
   * derives a dead summer, and a dead summer is not a cycle.
   */
  const classDerived = (): { year: number; basis: string } | null => {
    const year = cycleFromClassYear(haystack);
    if (year === null || isStaleCycle(year)) return null;
    return { year, basis: `derived from the graduating class the posting names` };
  };

  const derivedCycle = statedCycle ? null : (deriveRecruitingCycle(listing) ?? classDerived());
  // `knownCycle` last: a year the posting states itself always wins over one
  // supplied from outside, so this can only fill a gap and never overrule the
  // page.
  const recruitingCycle = statedCycle ?? derivedCycle?.year ?? knownCycle ?? null;
  if (statedCycle) evidence.push(`recruiting cycle ${statedCycle}`);
  else if (derivedCycle) evidence.push(`recruiting cycle ${derivedCycle.year} - ${derivedCycle.basis}`);

  const titleMentionsInternship = /\b(intern|internship|summer analyst|summer associate)\b/i.test(
    listing.title,
  );

  /**
   * These weights are not a probability, and it is worth being plain about it.
   *
   * Only four totals are reachable - 0.7, 0.8, 0.9 and 1.0 - so moving the
   * 0.8 threshold to 0.75 or 0.85 changes precisely nothing. What the
   * arithmetic actually encodes is:
   *
   *   relevance AND sector AND (a cycle OR the title says internship)
   *
   * Left as a score because `confidence` is stored and displayed, and because
   * a real calibration is now possible for the first time - the labelled set
   * in scripts/data/classifier-eval.json is what a future weighting would have
   * to be measured against. Until then, nobody should imagine this number can
   * be tuned.
   *
   * A DERIVED cycle scores the same as a stated one. That is the decision
   * taken on 19 September: a posting whose deadline says November 2026 is a
   * 2027 posting, and holding it back for not spelling the year out was
   * costing real openings. The derivation is recorded in the evidence, so the
   * reviewer sees it even when nobody has to act on it.
   */
  let confidence = 0;
  if (relevanceHit) confidence += 0.4;
  if (sector) confidence += 0.3;
  if (recruitingCycle) confidence += 0.2;
  if (titleMentionsInternship) confidence += 0.1;

  // Rounded once, then used for BOTH the stored score and the auto-approve
  // comparison. 0.4 + 0.3 + 0.1 is 0.7999999999999999 in binary floating
  // point, so a listing scoring exactly the threshold failed `>= 0.8` and went
  // to review - the rule silently meant "greater than 0.8" on some score paths
  // and "at least 0.8" on others.
  const rounded = Math.round(Math.min(1, confidence) * 100) / 100;

  const relevant = Boolean(relevanceHit);
  /**
   * EVERY condition that holds a listing back has to name itself.
   *
   * `needsHumanReview` below is the negation of a five-part conjunction, and
   * this chain only covered the first three of them. A listing failing on
   * confidence, on `verifiable`, or on the dead-year guard was queued with
   * `reasonForUncertainty: null` - which reads as "(none stated)" and tells a
   * reviewer nothing at all.
   *
   * Measured 11 October 2026: 79 of the 244 listings in the review queue had
   * no stated reason, among them "2027 Investment Banking Off-Cycle
   * Internship (Madrid)", "2027 Global Capital Markets Off-Cycle Internship
   * (Paris)" and "2027 ISG Central Risk Industrial Placement Internship" -
   * relevant, sector known, cycle 2027, and held for a reason nobody could
   * see. A queue nobody can act on is how 748 listings accumulated while
   * `reviewed_by` stayed NULL on all 21,716 rows.
   *
   * The order follows the conjunction, so the reason given is the first thing
   * that actually failed rather than the last thing checked.
   */
  const reasonForUncertainty = !relevant
    ? "no internship/summer-program phrase matched"
    : !sector
      ? "relevant but no sector keyword matched"
      : !recruitingCycle
        ? "relevant with a sector, but no recruiting-cycle year found"
        : rounded < AUTO_APPROVE_THRESHOLD
          ? `confidence ${rounded} is below the ${AUTO_APPROVE_THRESHOLD} auto-approve threshold`
          : !quality.verifiable
            ? "nothing to check it against: no external id or own account, a stub description, or no URL of its own"
            : mentionsOnlyDeadYears(haystack)
              ? "the only years it names are past ones, and it states no cycle"
              : null;

  // Read from the requirements section first where there is one - that is
  // where a firm states who may apply - falling back to the whole posting.
  const eligibility = readEligibility(
    `${listing.title} ${requirementsRaw ?? ""} ${listing.descriptionRaw}`,
    recruitingCycle,
  );
  if (eligibility.basis === "stated") {
    evidence.push(
      `eligibility: ${eligibility.level ?? "class"} -> grad ${eligibility.gradYears.join(", ") || "unspecified"}` +
        (eligibility.evidence[0] ? ` ("${eligibility.evidence[0]}")` : ""),
    );
  }
  if (requirementsRaw) evidence.push(`requirements section found (${requirementsRaw.length} chars)`);

  return {
    relevant,
    sector,
    subsector: listing.division,
    recruitingCycle,
    // Rounded to two decimals before it is compared or stored. 0.4 + 0.3 + 0.1
    // is 0.7999999999999999 in binary floating point, so a listing that scores
    // exactly the auto-approve threshold fails `>= 0.8` and goes to review -
    // a rule that silently means "greater than 0.8" for some score paths and
    // "at least 0.8" for others.
    confidence: rounded,
    matchedEvidence: evidence,
    reasonForUncertainty,
    /**
     * Auto-approval now also requires that the listing be VERIFIABLE and that
     * its eligibility be stated rather than inferred.
     *
     * The old rule asked only "are we confident this is a relevant
     * internship". That let through anything the generic connector had scraped
     * off a page with no id, no body and no address of its own - exactly the
     * listings there is no way to check. Publishing those without a human is
     * how a page fragment reaches a student as an opening.
     *
     * An inferred eligibility is a reasonable default for ranking but not a
     * fact about this employer, and `eligibleGradYears` is what decides who is
     * shown the posting - so a guess there goes to a human rather than to
     * students.
     */
    /**
     * Auto-approval no longer requires a STATED eligibility.
     *
     * It did briefly, and that was the wrong trade: Harris Williams' "2027 M&A
     * Summer Associate (Boston)" is unmistakably a real internship that simply
     * never names a graduation year, and holding every posting like it meant
     * losing real openings to a missing field. A posting we are confident about
     * is published; where the eligibility is unknown it is left EMPTY rather
     * than invented, and an empty list restricts nobody (see
     * getRelevantPostings).
     *
     * `verifiable` stays required. That one is not about missing information -
     * it is about whether a real record exists in a real system at all, which
     * is the difference between a posting we could not fully read and a page
     * fragment that was never a posting.
     */
    /**
     * Auto-approval no longer requires a STATED recruiting cycle either, and
     * for the same reason as eligibility above - but the cost was larger,
     * because this one fell almost entirely on the sectors outside investment
     * banking.
     *
     * Investment banks title their postings by convention: "2027 Investment
     * Banking Summer Analyst" names its cycle in the first four characters.
     * Nobody else does. A hedge fund posts "Quantitative Researcher Intern", a
     * private equity firm posts "Wealth Builder Intern", and neither states a
     * year anywhere - so `recruitingCycle` came back null and the posting
     * could NEVER be auto-approved, whatever its confidence, whatever its
     * description said, however plainly it was a real internship.
     *
     * Measured 20 September 2026 across every sector: 81 open listings met
     * every other bar - relevant, verifiable, not stale, confident, sector
     * known - and were held solely for this. The auto-approval rate tells the
     * same story from the other side: investment banking 59%, private equity
     * 11%, other finance 0%.
     *
     * A missing cycle is missing information, not evidence of a problem. The
     * case that matters - a posting for a cycle that has already passed - is
     * caught by `staleCycle`, which needs a cycle to have been stated and
     * still sends those to a human. Dropping the requirement therefore loses
     * no protection; it stops punishing every sector that does not write
     * dates into its job titles.
     */
    needsHumanReview: !(
      relevant &&
      sector &&
      rounded >= AUTO_APPROVE_THRESHOLD &&
      quality.verifiable &&
      /**
       * An address a student can be sent to, or a person looks at it.
       *
       * `quality.verifiable` requires a non-null listing URL and says nothing
       * about what kind of URL it is, and the whole of auto-approval below
       * rests on page-supplied text. The URLs are page-supplied too - the
       * generic connector copies a JSON-LD `url` or a matching anchor href
       * verbatim - so `javascript:`, `data:`, a scheme-less string, a
       * loopback address or an odd port could all reach a student's href
       * with no human in the loop (security review, 10 October 2026).
       *
       * Held for review rather than rejected: an odd URL is a reason to ask
       * somebody, and the listing may be a real opening whose link was read
       * out of the wrong attribute. `publicHttpUrl` turns away no legitimate
       * board, including the ATS hosts that are legitimately off-domain.
       */
      hasPublishableUrls(rawListing) &&
      /**
       * A cycle is not required - but DEAD-year evidence with no live cycle
       * to set against it still goes to a human.
       *
       * "Internship - Marketing (Year-Round)", described as "our internship
       * program began in 2019", names no cycle at all. The staleness branch
       * above cannot help: it needs a cycle to have been extracted. Dropping
       * the cycle requirement outright would publish it.
       *
       * So the narrow version of the old rule survives: silence about the
       * year is fine, a dead year is not.
       */
      (recruitingCycle !== null || !mentionsOnlyDeadYears(haystack))
    ),
    isPosting: true,
    qualityIssues: [],
    verifiable: quality.verifiable,
    staleCycle: false,
    eligibility,
    requirementsRaw,
    requirementsList,
  };
}
