/**
 * A crawled role title cut down to what the role actually is.
 *
 * Firms title postings for their own careers page, not for a grid of cards:
 * "2028 Strategic Advisory: Mergers & Acquisitions Summer Analyst Program –
 * Chicago Industrials" spends two lines on the cycle, the division and the
 * program type - all of which the card already says, or which every other
 * card at that firm repeats - before reaching the part that tells two Evercore
 * roles apart. Truncated, that part was exactly what got cut.
 *
 * What goes:
 *   - the cycle year ("2028 ", "Class of 2028 ", "– 2028 Grads",
 *     "(for 2028 Graduates)", "- Summer 2028"): the card's meta line says it,
 *   - the program type ("Summer Analyst Program", "Summer Intern Program",
 *     "Summer Analyst", "Summer Internship"): every card here is one,
 *   - a division before a colon ("Strategic Advisory: "): the group after it
 *     is the specific part.
 * What stays: the group or desk, and any city or team suffix, which is often
 * the only difference between a firm's postings.
 *
 * Display only. The stored title is untouched and the full one is still shown
 * in the posting's detail; if the rules would leave nothing, the original
 * comes back.
 */
export function shortRoleTitle(title: string): string {
  let t = title
    // Cycle markers.
    .replace(/^\s*(class of\s+)?20\d\d(\s*[-–:]\s*|\s+)/i, "")
    .replace(/\s*\(for 20\d\d graduates\)/i, "")
    .replace(/\s*[-–]\s*20\d\d grads\b/i, "")
    .replace(/\s*[-–]\s*(winter\s*&\s*)?summer 20\d\d\b/i, "")
    // Program type, longest phrases first so "Summer Analyst Program" is not
    // left as "Program".
    .replace(/\s*\bsummer (analyst|intern(ship)?) program\b/gi, "")
    .replace(/\s*\bsummer (analyst|internship)\b/gi, "")
    // A board's button text read into the title: G2 Capital's "Summer
    // Analyst 2027 Boston, Massachusetts Investment Banking Apply Now".
    .replace(/\s*\bapply now\b[!.]?\s*$/i, "");

  // Division before a colon: keep the specific part after it.
  const colon = t.indexOf(":");
  if (colon !== -1 && t.slice(colon + 1).trim()) t = t.slice(colon + 1);

  t = t
    // Separators the removals left dangling or doubled.
    .replace(/(\s*[-–]\s*){2,}/g, " – ")
    .replace(/^[\s\-–:,]+|[\s\-–:,]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return t || title.trim();
}

/**
 * Does this title actually name a role?
 *
 * A posting a student cannot identify is not one they can act on. The 21
 * September database merge turned 18 titles into timestamps ("Summer Analyst,
 * Investment Banking, BDO Capital Advisors - Summer 2028 (Richmond)" was stored
 * as "2028-01-01 00:00:00+00"), and they went straight onto the Internships
 * tab with an Apply button - nothing on the way checked that a title said
 * anything. This is that check, in the two places it belongs: savePosting will
 * not store such a row, and isRealPosting will not show one.
 *
 * The bar is deliberately low - a real title in any language passes: it has
 * to hold a word (two letters in a row, any script) and must not be shaped
 * like a date or timestamp.
 */
export function isNamedRoleTitle(title: string | null | undefined): boolean {
  const t = (title ?? "").trim();
  if (!t) return false;
  if (/^\d{1,6}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/.test(t)) return false;
  return /\p{L}{2}/u.test(t);
}

/**
 * Careers-site placeholders: entries a board lists beside its real roles that
 * are not roles at all. "Join our Talent Community!" (Brown Gibbons Lang,
 * 2027) was stored and shown with an Apply button; a general application, a
 * resume drop or a contact page is the same thing under another name.
 *
 * Phrases, not words, and only ones that name the placeholder itself:
 *   - "apply now" is NOT here. It is button text a connector read into a
 *     real title ("Summer Analyst 2027 Boston, Massachusetts Investment
 *     Banking Apply Now"); shortRoleTitle drops it for display.
 *   - "join our" alone is NOT here: "Join our 2028 Summer Analyst Program"
 *     is a role.
 *   - Nothing requires an internship word. "Praktikant", "Werkstudent",
 *     "Stage H/F", "Apprentice" and "Trainee" are real roles that no such
 *     list would name; measured on 24 September 2026, one would have hidden
 *     86 of them.
 *
 * Written once so the JavaScript check and the SQL filter cannot disagree:
 * each fragment uses only what both regex dialects read the same way
 * (literals, `(?:a|b)`, `?`), and a space means any run of whitespace.
 * Only the start is anchored to a word boundary: every phrase begins with an
 * ASCII letter, where JavaScript's `\b` and Postgres's `\y` agree, while
 * after "é" they do not (JavaScript counts it as a non-word character).
 */
const PLACEHOLDER_PHRASES = [
  "talent (?:community|network|pool)",
  "general (?:application|interest)",
  "general candidate inquir(?:y|ies)",
  "(?:open|spontaneous|unsolicited|speculative) applications?",
  "expression of interest",
  "r(?:e|é)sum(?:e|é) (?:drop|submission)",
  "submit your (?:r(?:e|é)sum(?:e|é)|cv)",
  "stay connected",
  "future opportunities",
  "initiativbewerbung",
  "candidature spontan(?:ée|ee)",
];

const placeholderSource = (wordBoundary: string) =>
  `${wordBoundary}(?:${PLACEHOLDER_PHRASES.map((p) => p.replaceAll(" ", "\\s+")).join("|")})`;

const PLACEHOLDER_TITLE = new RegExp(placeholderSource("\\b"), "i");

/** The same rule for Postgres (`role_title ~* ...`), where the word boundary is `\y`. */
export const PLACEHOLDER_TITLE_SQL_PATTERN = placeholderSource("\\y");

/** Is this title a careers-site placeholder rather than a role? See PLACEHOLDER_PHRASES. */
export function isPlaceholderTitle(title: string | null | undefined): boolean {
  return PLACEHOLDER_TITLE.test(title ?? "");
}
