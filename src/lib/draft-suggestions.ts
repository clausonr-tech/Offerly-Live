// Suggested answers for the drafter's hand-typed fields.
//
// A student writing to someone they pulled from a firm is asked "What do you
// and this person have in common?", "Why them?", "What do you want to learn
// from them?" - and most of the answers are facts we already hold on both
// sides. So each field gets a suggestion under it, which the student reads
// and uses (or not) with one click. Nothing is filled in for them: a cold
// email that claims a connection the student never checked is worse than one
// that claims none, which is why common ground reaches the model as "verified
// by the student".
//
// Two layers. The rules here find the facts - shared school, hometown, club,
// employer, major, cohort - deterministically, instantly and for free, and
// write a plain suggestion from them. The model (draft-suggestions-ai.ts) then
// writes the open-ended ones and a more natural phrasing, from the same facts
// and nothing else. Pure: no database, no network.

import { acronymFor, clubSignals, expandClub } from "@/lib/club-signals";
import { compareContact, type Similarity } from "@/lib/contact-similarity";
import { CATEGORY_LABELS } from "@/lib/firm-metadata";
import { normalizeFirmName } from "@/lib/firm-name";
import { LOOKALIKE_SCHOOLS, schoolSpellings } from "@/lib/school-name";

/** Acronyms that mean something else in a banker's background - finance,
 *  titles, months, places - so a club abbreviated the same way is not found
 *  by them. */
const COMMON_ACRONYMS = new Set(
  (
    "ABS MBS CMBS RMBS CDO CLO LBO IPO DCF ECM DCM TMT FIG FX GDP CFA CPA EPS EBITDA ROE ROI M&A PE VC HF AM IB ST " +
    "CEO CFO COO CTO MD VP SVP EVP HR IT PR AI ML ESG SEC FINRA JAN FEB MAR APR MAY JUN JUL AUG SEP SEPT OCT NOV DEC " +
    "NYC SF LA DC UK US USA EU BA BS MA MS MBA PHD"
  ).split(" "),
);

/** Words that, right after a firm's name, make it a different firm. */
const SIBLING_FIRM_WORDS = new Set([
  "capital",
  "securities",
  "asset",
  "partners",
  "advisors",
  "credit",
  "ventures",
  "wealth",
  "energy",
]);

/** The fields a suggestion is offered for, by their name in draft-occasions. */
export const SUGGESTED_FIELDS = [
  "specificReason",
  "introReason",
  "financeInterest",
  "wantToLearn",
  "personalConnection",
  "interviewTeam",
] as const;
export type SuggestedField = (typeof SUGGESTED_FIELDS)[number];

export function isSuggestedField(name: string): name is SuggestedField {
  return (SUGGESTED_FIELDS as readonly string[]).includes(name);
}

/** How long a suggestion may be - the fields are notes, not paragraphs. */
export const SUGGESTION_MAX_CHARS = 220;

export type Suggestion = {
  text: string;
  source: "rules" | "ai";
  /** The facts it rests on, for the student to check: "Penn", "Wharton
   *  Investment Club". Empty for one that rests on their own profile. */
  basis: string[];
};

export type SuggestionSet = Partial<Record<SuggestedField, Suggestion>>;

/** A connection between the two, as the suggestions and the record store it. */
export type Connection = Pick<Similarity, "kind" | "label" | "note" | "weight">;

/** The student's side, from their profile. */
export type SuggestionStudent = {
  name?: string | null;
  school?: string | null;
  gradYear?: number | null;
  major?: string | null;
  hometown?: string | null;
  clubsAndActivities?: string | null;
  interests?: string | null;
  priorExperience?: string[] | null;
  targetLocations?: string[] | null;
  preferredCategories?: string[] | null;
  targetGroup?: string | null;
  motivations?: string | null;
  proudExperience?: string | null;
};

/** The person they are writing to, as we hold them. */
export type SuggestionRecipient = {
  name: string;
  firm?: string | null;
  role?: string | null;
  /** Their group or desk, when we know it ("TMT", "Leveraged Finance"). */
  group?: string | null;
  school?: string | null;
  gradYear?: number | null;
  currentCity?: string | null;
  /** Free text: a contact's background, a directory person's job history. */
  background?: string | null;
  notes?: string | null;
};

const split = (value: string | null | undefined) =>
  (value ?? "")
    .split(/[,;/|\n]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 8);

/** Lowercase words only, for finding one text inside another. */
const words = (value: string) =>
  ` ${value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;

/**
 * What the two have in common, strongest first.
 *
 * The structured comparison the contact search already trusts (school,
 * cohort, club, hometown, employer, major, interest), plus a read of what we
 * hold about them as free text - a background or job history names clubs,
 * firms and places that no structured field carries. A fact is only a
 * connection when it appears on BOTH sides; nothing is inferred.
 */
export function findConnections(student: SuggestionStudent, recipient: SuggestionRecipient): Connection[] {
  const clubs = clubSignals({ offerly: student.clubsAndActivities });
  const employers = (student.priorExperience ?? []).map((e) => e.trim()).filter(Boolean).slice(0, 8);
  const interests = split(student.interests);

  const structured = compareContact({
    student: {
      school: student.school,
      gradYear: student.gradYear,
      major: student.major,
      targetCities: student.targetLocations,
      hometown: student.hometown,
      clubs,
      interests,
      priorEmployers: employers,
    },
    contact: {
      name: recipient.name,
      title: recipient.role,
      school: recipient.school,
      gradYear: recipient.gradYear,
      currentCity: recipient.currentCity,
    },
  }).matches;

  const out: Connection[] = structured.map(({ kind, label, note, weight }) => ({ kind, label, note, weight }));
  const have = (kind: Connection["kind"], label: string) =>
    out.some((c) => c.kind === kind && words(c.label) === words(label));

  // The free text: their background and notes. Every rule here asks for more
  // than a word appearing - "Boston Consulting Group" is not a Bostonian,
  // "Leveraged Finance" is not a finance degree, "Penn State" is not Penn.
  const raw = [recipient.background, recipient.notes].filter(Boolean).join(" \n ");
  const text = words(raw);
  if (text.trim()) {
    const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const phrase = (needle: string) => esc(words(needle).trim());

    // School: any way the school is written that is safe to find in prose -
    // "University of Pennsylvania", "UPenn", "Wharton School" for a student
    // who wrote "Penn" - but never one ordinary word ("Duke Energy") and never
    // followed by a word that makes it another school ("Penn State").
    // "&" read as "and" (Texas A&M), and lookalike schools blanked first, so
    // "Indiana University of Pennsylvania" never reads as Penn.
    const schoolText = ` ${words(raw.replace(/&/g, " and ")).trim().replace(LOOKALIKE_SCHOOLS, " ")} `;
    if (
      student.school &&
      !out.some((c) => c.kind === "school") &&
      schoolSpellings(student.school).some((spelling) =>
        new RegExp(` ${esc(spelling)} (?!(?:state|tech|polytechnic|community|of) )`).test(schoolText),
      )
    ) {
      out.push({ kind: "school", label: student.school, note: `Also ${student.school}`, weight: 5 });
    }

    // Clubs: one connection per club the student wrote, however many ways it
    // can be spelled. A generic name of two words or fewer ("Investment
    // Club") is every school's; a short acronym only counts in capitals, as a
    // word ("SEP", never "Sep").
    for (const entry of split(student.clubsAndActivities)) {
      // An acronym made from their club's name counts in capitals ("TIS",
      // "SMIF") unless it is also a word of finance or the calendar: "Asian
      // Business Society" is ABS, and so is every asset-backed securities desk.
      const madeUp = acronymFor(entry);
      const hit = expandClub(entry).find((name) => {
        const n = words(name).trim();
        if (!n) return false;
        if (madeUp && name === madeUp && COMMON_ACRONYMS.has(name.toUpperCase())) return false;
        if (n.length <= 4 && !n.includes(" ")) return new RegExp(`\\b${esc(name.trim())}\\b`).test(raw);
        return n.split(" ").length > 2 && text.includes(` ${n} `);
      });
      if (hit && !have("club", hit) && !out.some((c) => c.kind === "club" && c.label === entry)) {
        out.push({ kind: "club", label: entry, note: `Both in ${entry}`, weight: 4 });
      }
    }

    // Employers: the same firm, not a sibling that starts the same way -
    // "Bain" is not "Bain Capital", "Citadel" not "Citadel Securities".
    // The firm as the student wrote it, and as firm names normalise ("J.P.
    // Morgan" meets "JPMorgan Chase").
    for (const employer of employers) {
      const e = words(employer).trim();
      if (e.length <= 2 || have("employer", employer)) continue;
      const spellings = [...new Set([e, normalizeFirmName(employer)])].filter((v) => v.length > 2);
      const matched = spellings.some((spelling) => {
        const m = new RegExp(` ${esc(spelling)} (\\S+)?`).exec(`${text} `);
        if (!m) return false;
        const next = m[1];
        return !(next && SIBLING_FIRM_WORDS.has(next) && !e.split(" ").includes(next));
      });
      if (matched) out.push({ kind: "employer", label: employer, note: `Also worked at ${employer}`, weight: 3 });
    }

    // Hometown: said as one - "grew up in Boston", "from Reading, PA",
    // "Boston native" - never a city named in passing: job histories list
    // office cities, and "Boston Consulting Group" is not a hometown.
    const town = student.hometown?.split(",")[0]?.trim();
    if (town && words(town).trim().length > 2 && !out.some((c) => c.kind === "hometown")) {
      const t = phrase(town);
      if (new RegExp(` (?:grew up in|raised in|born in|native of|hometown(?: is)?|from) ${t} | ${t} native `).test(`${text} `)) {
        out.push({ kind: "hometown", label: town, note: `Both from ${town}`, weight: 3 });
      }
    }

    // Major: as a degree - "BS in Finance", "majored in Economics" - never a
    // desk name ("Leveraged Finance").
    if (student.major && !out.some((c) => c.kind === "major")) {
      const m = phrase(student.major);
      if (
        m.length > 2 &&
        new RegExp(` (?:ba|bs|bba|bsc|ma|ms|mba|major(?:ed)?|degree|studied|concentration|concentrated)(?: in| of)? ${m} `).test(
          `${text} `,
        )
      ) {
        out.push({ kind: "major", label: student.major, note: `Also studied ${student.major}`, weight: 1 });
      }
    }
  }

  // A shared graduating year is only common ground at a shared school - two
  // strangers from different colleges who graduated the same year have
  // nothing in common but a calendar.
  const sameSchool = out.some((c) => c.kind === "school");
  const kept = out.filter((c) => c.kind !== "cohort" || sameSchool);

  // A city they work in, alone, is not common ground - it is where the job is.
  return kept.filter((c) => c.kind !== "city").sort((a, b) => b.weight - a.weight);
}

/** "Both in X; also Penn" - the connections as the student would jot them. */
function commonGround(connections: Connection[]): Suggestion | undefined {
  const top = connections.slice(0, 2);
  if (top.length === 0) return undefined;
  return {
    text: clip(top.map((c) => c.note).join("; ")),
    source: "rules",
    basis: top.map((c) => c.label),
  };
}

/** Shortened to the limit, never through the middle of an emoji. */
export function clip(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(t);
  return chars.length > SUGGESTION_MAX_CHARS ? `${chars.slice(0, SUGGESTION_MAX_CHARS - 1).join("").trimEnd()}…` : t;
}

/**
 * The suggestions the rules can write on their own, from facts alone.
 *
 * Only where a fact answers the question: common ground and "why them" from
 * the connections; the part of finance from the student's own sectors; the
 * firm and team from what we hold about the person. The open questions - what
 * to learn, how it connects to them - are the model's, from the same facts.
 */
export function ruleSuggestions(
  student: SuggestionStudent,
  recipient: SuggestionRecipient,
  connections: Connection[] = findConnections(student, recipient),
): SuggestionSet {
  const out: SuggestionSet = {};

  const ground = commonGround(connections);
  if (ground) {
    out.specificReason = ground;
    out.introReason = { ...ground, basis: [...ground.basis] };
  }

  const sectors = [...new Set(student.preferredCategories ?? [])]
    .map((c) => CATEGORY_LABELS[c as keyof typeof CATEGORY_LABELS] ?? null)
    .filter((c): c is string => !!c);
  const group = student.targetGroup?.trim();
  if (group || sectors.length) {
    out.financeInterest = {
      text: clip([group, sectors.slice(0, 2).join(" and ").toLowerCase()].filter(Boolean).join(", ")),
      source: "rules",
      basis: [],
    };
  }

  if (recipient.firm?.trim()) {
    const team = recipient.group?.trim();
    out.interviewTeam = {
      text: clip(team ? `${recipient.firm.trim()}, ${team}` : recipient.firm.trim()),
      source: "rules",
      basis: [recipient.firm.trim(), ...(team ? [team] : [])],
    };
  }

  return out;
}

/**
 * A stable fingerprint of everything the suggestions are built from, so a
 * cached set is used only while both sides are as they were.
 */
export function suggestionInputHash(student: SuggestionStudent, recipient: SuggestionRecipient): string {
  const text = JSON.stringify([student, recipient], (_k, v) => (v === undefined ? null : v));
  // FNV-1a, 32-bit: a fingerprint, not a secret.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The model's suggestions over the rules', field by field: the rules are the
 *  floor, the model's phrasing the ceiling, and a field the model left empty
 *  keeps the rules' answer. */
export function mergeSuggestions(rules: SuggestionSet, ai: SuggestionSet): SuggestionSet {
  const out: SuggestionSet = { ...rules };
  for (const field of SUGGESTED_FIELDS) {
    const a = ai[field];
    if (a?.text.trim()) out[field] = { ...a, basis: a.basis.length ? a.basis : (rules[field]?.basis ?? []) };
  }
  return out;
}

export type SuggestionOutcome = {
  field: SuggestedField;
  suggested: string;
  source: Suggestion["source"];
  basis: string[];
  submitted: string;
  /** used: sent as suggested. edited: taken, then changed. ignored: not taken. */
  outcome: "used" | "edited" | "ignored";
};

/**
 * What the student did with each suggestion, for the record kept on the draft.
 * "Taken" is the click on "Use this"; a field typed to match the suggestion
 * word for word counts as used too.
 */
export function suggestionOutcomes(
  shown: SuggestionSet,
  submitted: Record<string, string>,
  taken: ReadonlySet<string>,
): SuggestionOutcome[] {
  const same = (a: string, b: string) => words(a) === words(b);
  const out: SuggestionOutcome[] = [];
  for (const field of SUGGESTED_FIELDS) {
    const s = shown[field];
    if (!s) continue;
    const value = (submitted[field] ?? "").trim();
    const outcome: SuggestionOutcome["outcome"] = value && same(value, s.text)
      ? "used"
      : taken.has(field) && value
        ? "edited"
        : "ignored";
    out.push({ field, suggested: s.text, source: s.source, basis: s.basis, submitted: value, outcome });
  }
  return out;
}
