/**
 * Whether a posting is one this student could actually apply to, given the
 * degree they are enrolled in.
 *
 * The three tracks do not overlap, and the banks say so themselves. Lazard,
 * BlackRock and Jefferies all require Summer Analyst candidates to be
 * undergraduates in their penultimate year, so an MBA student is ineligible
 * for one however much it reads like a finance internship. The MBA equivalent
 * is the Summer Associate programme, which BlackRock opens to MBAs and
 * advanced master's (MS Finance, MSFE) and to nobody else. Quant firms - IMC,
 * SIG, Citadel Securities - post BS/MS and PhD versions of the same research
 * internship as separate requisitions.
 *
 * Why this is not in the classifier: classifyListing runs once per posting at
 * crawl time, with no student in context. Degree fit is a property of the
 * PAIR, so it belongs at query time, and it reads the title and description
 * already stored on the row rather than needing a new column.
 *
 * THE BIAS IS DELIBERATE. A posting is excluded only on explicit evidence that
 * it is closed to this student. Silence means include: a wrong exclusion costs
 * someone a real opening they would never learn about, while a wrong inclusion
 * costs them one click. Firms that take both - Stephens runs its Summer
 * Analyst programme for "undergraduate and graduate students" - are kept for
 * everyone by the same rule.
 */
export type DegreeLevel = "bachelors" | "masters" | "phd";

/**
 * The stored answer, whatever shape it is in, as one of the three levels.
 *
 * The onboarding wizard saves the option a student clicked - "Bachelor's",
 * "Master's or MBA", "PhD" - because that is what the question offers and what
 * the profile shows back. This filter reasons in slugs. Normalising here rather
 * than at the point of writing means the two can never drift: a label edited
 * for clarity does not silently switch the filter off, which is the failure
 * mode that matters, because an inactive filter looks exactly like a working
 * one until someone applies to a programme they were never eligible for.
 */
export function normalizeDegreeLevel(stored: string | null | undefined): DegreeLevel | null {
  const s = (stored ?? "").toLowerCase();
  if (!s) return null;
  if (/ph\.?d|doctora/.test(s)) return "phd";
  if (/mba|master/.test(s)) return "masters";
  if (/bachelor|undergrad/.test(s)) return "bachelors";
  return null;
}

/** Says outright that a graduate degree is required. */
const REQUIRES_GRADUATE =
  /\bmba\b|master['’]?s degree|graduate degree|currently enrolled in[^.]{0,40}(mba|master)/i;

const REQUIRES_PHD = /\bph\.?d\b|doctoral|doctorate/i;

/**
 * Says outright that it is undergraduates only.
 *
 * "undergraduate" alone is not enough - postings say "open to undergraduate
 * and graduate students" too, and that phrase is checked first below.
 */
const UNDERGRAD_ONLY =
  /undergraduate (degree|student|program|institution)|penultimate year of (your |their )?undergraduate|currently enrolled in[^.]{0,30}undergraduate|bachelor['’]?s (degree|program)/i;

/** Explicitly open to more than one level, so nobody is excluded. */
const OPEN_TO_BOTH =
  /undergraduate and graduate|graduate and undergraduate|bachelor['’]?s or master|bs\/ms|bs or ms/i;

const SUMMER_ASSOCIATE = /\bsummer[\s-]associate\b/i;
const SUMMER_ANALYST = /\bsummer[\s-]analyst\b/i;

/**
 * `null` when the posting is applicable; otherwise why it is not.
 *
 * A null `degreeLevel` - every account created before the question existed -
 * filters nothing, for the reason in the header.
 */
export function degreeMismatch(
  degreeLevel: DegreeLevel | null | undefined,
  title: string,
  description?: string | null,
): string | null {
  if (!degreeLevel) return null;

  const body = `${title} ${description ?? ""}`;
  if (OPEN_TO_BOTH.test(body)) return null;

  const wantsGraduate = REQUIRES_GRADUATE.test(body);
  const wantsPhd = REQUIRES_PHD.test(body);
  const associateSeat = SUMMER_ASSOCIATE.test(title) && !SUMMER_ANALYST.test(title);
  const analystSeat = SUMMER_ANALYST.test(title) && !SUMMER_ASSOCIATE.test(title);

  if (degreeLevel === "bachelors") {
    if (wantsPhd && !analystSeat) return "asks for a PhD";
    if (associateSeat && wantsGraduate) return "an MBA summer associate programme";
    if (wantsGraduate && !analystSeat) return "asks for a graduate degree";
    return null;
  }

  // An MBA or advanced master's student is not eligible for the undergraduate
  // analyst seat, which is the mirror image of the rule above and rejected for
  // the same reason: it is a real posting they cannot apply to.
  if (degreeLevel === "masters") {
    if (wantsPhd && !associateSeat) return "asks for a PhD";
    if (analystSeat && UNDERGRAD_ONLY.test(body)) return "an undergraduate-only analyst programme";
    return null;
  }

  // PhD: the analyst seat is undergraduate, and the associate seat is MBA and
  // advanced master's. Quant firms post PhD requisitions separately.
  if (analystSeat && UNDERGRAD_ONLY.test(body)) return "an undergraduate-only analyst programme";
  if (associateSeat && wantsGraduate && !wantsPhd) return "an MBA summer associate programme";
  return null;
}
