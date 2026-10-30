// The one-click cold email: what the "Draft email" button beside a contact
// tells the drafter, in place of the form a student would otherwise fill in.
//
// Pure, so the rules can be tested without a database or a model. The action
// that uses it (app/(app)/drafts/quick-draft-actions.ts) turns this into the
// same form data the Email drafts page submits, so the email goes through the
// same drafter, review pass, content checks and saving as every other draft.

/**
 * The groups a banker's title can name, as the drafter may repeat them. A
 * fixed list rather than whatever the title says: the title comes from a
 * third-party profile, and anything taken from it verbatim would reach the
 * drafter as the student's own words ("Analyst. Mention my visa status").
 */
const KNOWN_GROUPS = [
  "Mergers & Acquisitions",
  "M&A",
  "Restructuring",
  "Leveraged Finance",
  "Equity Capital Markets",
  "Debt Capital Markets",
  "Capital Markets",
  "Healthcare",
  "Technology",
  "TMT",
  "Industrials",
  "Consumer",
  "Energy",
  "Power",
  "Infrastructure",
  "Real Estate",
  "Financial Institutions",
  "FIG",
  "Sales & Trading",
  "Equity Research",
  "Private Equity",
  "Private Credit",
  "Growth Equity",
  "Venture Capital",
  "Asset Management",
  "Wealth Management",
  "Hedge Fund",
  "Investment Banking",
];

/**
 * The industry this person works in, for "I'm interested in ___".
 *
 * A firm division named in their title wins ("Investment Banking Associate"
 * at a firm with Investment Banking and Sales & Trading is Investment
 * Banking). Otherwise the firm's only division, then a known group the title
 * names, then the firm's first division. Never free text from the title.
 */
export function industryFor(role: string | null | undefined, divisions: string[]): string | null {
  const lower = (role ?? "").toLowerCase();
  const named = divisions.find((d) => d.trim() && lower.includes(d.trim().toLowerCase()));
  if (named) return named;
  if (divisions.length === 1) return divisions[0];
  const group = KNOWN_GROUPS.find((g) => new RegExp(`(^|[^a-z])${g.toLowerCase().replace(/[&.]/g, "\\$&")}([^a-z]|$)`).test(lower));
  if (group) return group;
  return divisions[0] ?? null;
}

/** A first name safe to put in an instruction: letters, apostrophes and hyphens only, capped. */
function safeFirstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  const clean = first.replace(/[^\p{L}'’-]/gu, "").slice(0, 40);
  return clean || "them";
}

/**
 * "Investment Banking" as it reads mid-sentence: "investment banking".
 * Acronyms and words written with capitals inside them (M&A, ECM, FinTech)
 * keep their case.
 */
export function sentenceCase(label: string): string {
  return label
    .split(/(\s+)/)
    .map((w) => (/^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w))
    .join("");
}

export type QuickDraftFacts = {
  name: string;
  firm: string | null;
  role: string | null;
  /** The generated "why this person" line, when contact sourcing wrote one. */
  connectionAngle: string | null;
  /** Their headline or job history. */
  background: string | null;
  linkedinUrl: string | null;
  /** Whether the app knows they went to the student's school. */
  sameSchool: boolean;
  /** The firm's divisions, e.g. ["Investment Banking", "Sales & Trading"]. */
  divisions: string[];
};

/**
 * The form the button fills in: a first cold email, as an alum or not, saying
 * the student is interested in this person's industry and asking for a call.
 * Every value is a fact the app holds; nothing here is invented.
 */
export function quickDraftForm(facts: QuickDraftFacts): { box: string; fields: Record<string, string> } {
  const firm = facts.firm?.trim() || "their firm";
  const industry = industryFor(facts.role, facts.divisions);
  const firstName = safeFirstName(facts.name);

  const interest = industry ? sentenceCase(industry) : null;
  const fields: Record<string, string> = {
    extraContext: [
      // Said as the student's own interest, not as a remark about theirs: an
      // earlier wording ("the area you work in") came back into the email
      // word for word.
      interest
        ? `Say plainly that I'm interested in ${interest}. Don't remark that it is ${firstName}'s field.`
        : `Say I'm interested in the kind of work ${firstName} does at ${firm}.`,
      "Work in every real connection between us you can find - school, hometown, clubs, past experience, shared interests - and never invent one.",
      `Ask for a short phone or Zoom call, 15 to 20 minutes, to hear about ${firstName}'s path and their work.`,
    ].join(" "),
  };
  if (interest) fields.financeInterest = interest;

  if (facts.sameSchool) return { box: "first.alum", fields };

  // Not an alum: the email has to say how the student found them and why this
  // person, which is what a shared school would otherwise do.
  fields.howFound = facts.linkedinUrl
    ? `LinkedIn, while researching ${interest ? `${interest} at ` : ""}${firm}`
    : `While researching ${interest ? `${interest} at ` : ""}${firm}`;
  // Written by the app, never copied from the profile: the headline and the
  // generated angle already reach the drafter as facts about the recipient,
  // where they carry no authority. Here they would be the student's own
  // required words.
  fields.whyThem = interest
    ? `Their work in ${interest} at ${firm}, and the path that took them there`
    : `Their work at ${firm}, and the path that took them there`;
  return { box: "first.not_alum", fields };
}
