import { providerCityName } from "@/lib/city-spelling";
// How likely is this person to actually write back?
//
// Not "how senior are they" or "how good is the firm" - the question a student
// with forty names and one evening needs answered is which of these emails gets
// a reply. That is mostly about overlap: an alum from your school who ran your
// club answers; a managing director you share nothing with does not.
//
// Every signal is deterministic and derived from stored fields, so a card can
// always say exactly why someone was ranked where they were. Nothing here is
// generated, which means it can never invent a connection the data doesn't
// support - the failure mode that matters most when the output is "email this
// stranger because you have X in common".
//
// The signal list is a table rather than a chain of ifs so new overlap is cheap
// to add: give it a weight, a chip label and a sentence, and it participates in
// both the ranking and the explanation with no other changes.

type SignalKind =
  | "school"
  | "degree"
  | "hometown"
  | "club"
  | "employer"
  | "cohort"
  | "interest"
  | "location"
  | "reachable"
  /** Not an overlap itself - how MANY separate overlaps there are. */
  | "breadth";

export type Signal = {
  kind: SignalKind;
  /** Short chip text: "Same school". */
  label: string;
  /** Full sentence for the expanded why: "You both went to Boise State." */
  detail: string;
  weight: number;
};

/** Points per distinct kind of overlap beyond the first, and the ceiling. */
const BREADTH_POINTS = 6;
const BREADTH_MAX = 24;

export type ResponseLikelihood = {
  score: number;
  signals: Signal[];
  /** Coarse banding, so the UI doesn't have to know the weights. */
  band: "strong" | "warm" | "cold";
};

/**
 * One person, flattened from whichever table they came from. directoryPeople
 * and the student's own contacts store overlapping facts under different column
 * names; normalising here means the scorer has one shape to reason about and
 * new sources cost a mapping rather than a second scorer.
 */
export type ScorablePerson = {
  name: string;
  firmName: string;
  title?: string | null;
  school?: string | null;
  degree?: string | null;
  gradYear?: number | null;
  /** Prior roles/employers, when known. */
  jobHistory?: string | null;
  /** Anything else searchable - notes, background, imported blurbs. */
  freeText?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
};

export type ScorableStudent = {
  school?: string | null;
  /** Field of study, matched against the person's degree. */
  major?: string | null;
  gradYear?: number | null;
  hometown?: string | null;
  interests?: string | null;
  clubsAndActivities?: string | null;
  priorExperience?: string[] | null;
  targetLocations?: string[] | null;
  nicheInterests?: string[] | null;
};

const norm = (s?: string | null) => (s ?? "").toLowerCase().trim();

/**
 * Splits a free-text or comma-joined field into meaningful terms, keeping the
 * student's own capitalisation alongside the lowercased form used for matching.
 *
 * Both halves are needed. Matching has to be case-insensitive, but the matched
 * term is then quoted back in a sentence the student reads before emailing a
 * stranger - and "You've both spent time at houlihan lokey" is the kind of
 * detail that makes the whole feature look automated and careless.
 */
type Term = { match: string; display: string };

function terms(value: string | string[] | null | undefined): Term[] {
  const raw = Array.isArray(value) ? value.join(", ") : (value ?? "");
  return raw
    .split(/[,;\n/|]+/)
    .map((t) => t.trim())
    // Short fragments match everything - "IB", "PE", "MD" would fire on any
    // paragraph. Three characters is the shortest thing that is evidence.
    .filter((t) => t.length > 3)
    .map((t) => ({ match: t.toLowerCase(), display: t }));
}

/** Joins matched terms for display, in the student's own words. */
function list(items: Term[], max = 2) {
  const shown = [...new Set(items.map((t) => t.display))].slice(0, max);
  return shown.length === 2 ? `${shown[0]} and ${shown[1]}` : shown.join("");
}

/** Everything about a person that free-text overlap can be searched against. */
function haystack(p: ScorablePerson) {
  return norm([p.jobHistory, p.freeText, p.title, p.school, p.degree].filter(Boolean).join(" ⋄ "));
}

/**
 * The parts of a person that can say WHERE THEY ARE. School and degree are
 * deliberately left out.
 *
 * A university is usually named after a place, and matching a city against it
 * credits people for living somewhere they merely studied - or never did.
 * Measured: a New York University graduate working in Chicago matched the
 * target city "New York City", scoring identically to someone actually in New
 * York, because "new york" is a substring of their school's name.
 */
function locationHaystack(p: ScorablePerson) {
  return norm([p.freeText, p.jobHistory, p.title].filter(Boolean).join(" ⋄ "));
}

export function scoreResponseLikelihood(
  student: ScorableStudent,
  person: ScorablePerson,
): ResponseLikelihood {
  const signals: Signal[] = [];
  const hay = haystack(person);

  // --- Alumni. The single strongest predictor of a reply, and the one students
  // are most often told to lead with. ---
  if (student.school && person.school && norm(student.school) === norm(person.school)) {
    signals.push({
      kind: "school",
      label: "Same school",
      detail: `You both went to ${person.school}.`,
      weight: 50,
    });
  } else if (student.school && norm(student.school).length > 3 && hay.includes(norm(student.school))) {
    // Their school column is empty but the name shows up in their history -
    // weaker evidence than a column match, so it scores lower and says so.
    signals.push({
      kind: "school",
      label: "School connection",
      detail: `${student.school} appears in their background.`,
      weight: 30,
    });
  }

  // --- Same field of study. Weighted under school but above most things: a
  // shared major is specific enough to open an email with, and it is the
  // overlap a student can most easily turn into a real question. ---
  if (student.major && person.degree) {
    const a = norm(student.major);
    const b = norm(person.degree);
    // Substring either way, not equality: "Finance" should match "BS Finance"
    // and "Finance & Economics", which is how degrees are actually recorded.
    if (a.length > 2 && (b.includes(a) || a.includes(b))) {
      signals.push({
        kind: "degree",
        label: "Same degree",
        detail: `You're both ${student.major} - they studied ${person.degree}.`,
        weight: 28,
      });
    }
  }

  // --- Hometown, home state, high school: all of these live in the same free
  // text, so one pass over the student's hometown terms catches each. ---
  for (const term of terms(student.hometown)) {
    if (hay.includes(term.match)) {
      signals.push({
        kind: "hometown",
        label: "Same area",
        detail: `Both connected to ${student.hometown}.`,
        weight: 25,
      });
      break;
    }
  }

  // --- Clubs, teams, societies, events. ---
  const clubs = terms(student.clubsAndActivities).filter((c) => hay.includes(c.match));
  if (clubs.length) {
    signals.push({
      kind: "club",
      label: clubs.length === 1 ? "Shared club" : "Shared clubs",
      detail: `You're both involved in ${list(clubs)}.`,
      // Capped: three shared clubs is not three times the reason one is.
      weight: Math.min(clubs.length * 22, 44),
    });
  }

  // --- Career path overlap: same prior employer, same programme, same route in.
  const employers = terms(student.priorExperience).filter((e) => hay.includes(e.match));
  if (employers.length) {
    signals.push({
      kind: "employer",
      label: "Career overlap",
      detail: `You've both spent time at ${list(employers)}.`,
      weight: Math.min(employers.length * 20, 40),
    });
  }

  // --- Cohort. Someone a few years out remembers recruiting and is junior
  // enough to have time to answer; a thirty-year veteran is neither. ---
  if (person.gradYear && student.gradYear) {
    const gap = student.gradYear - person.gradYear;
    if (gap >= 1 && gap <= 6) {
      signals.push({
        kind: "cohort",
        label: `${gap} year${gap === 1 ? "" : "s"} ahead`,
        detail: `They graduated in ${person.gradYear}, ${gap} year${gap === 1 ? "" : "s"} ahead of you - close enough to remember the process.`,
        weight: 15,
      });
    }
  }

  // --- Shared interests and sub-sector focus. ---
  const interests = [...terms(student.interests), ...terms(student.nicheInterests)].filter((i) =>
    hay.includes(i.match),
  );
  if (interests.length) {
    signals.push({
      kind: "interest",
      label: "Shared interest",
      detail: `You share an interest in ${list(interests)}.`,
      weight: Math.min(interests.length * 10, 25),
    });
  }

  // --- Geography of the role itself. ---
  // Both spellings, because a profile is written in the provider's vocabulary
  // and our chips are written in a student's.
  //
  // This signal never fired. A student targeting "New York City" and a person
  // whose record says "New York, New York" scored identically to someone in
  // Chicago - the label was matched verbatim against the profile text, and
  // "new york city" does not appear in it. toCrustdataRequest already knew
  // this and maps the label through providerCityName before searching; the
  // scorer was comparing the raw chip. Same fix, same helper, so the two
  // cannot disagree about what counts as the same city again.
  const where = locationHaystack(person);
  const locations = terms(student.targetLocations).filter((l) => {
    const provider = norm(providerCityName(l.display));
    return where.includes(l.match) || (provider.length > 3 && where.includes(provider));
  });
  if (locations.length) {
    signals.push({
      kind: "location",
      label: "Your target city",
      detail: `They're connected to ${locations[0].display}, somewhere you want to work.`,
      weight: 12,
    });
  }

  // --- Reachability. Not overlap, but it belongs in a "will they reply" score:
  // the best-matched person in the world cannot answer an email you have no
  // address for. Deliberately small - it breaks ties, it doesn't make them. ---
  if (person.email) {
    signals.push({
      kind: "reachable",
      label: "Has email",
      detail: "You have a direct email address for them.",
      weight: 8,
    });
  } else if (person.linkedinUrl) {
    signals.push({
      kind: "reachable",
      label: "On LinkedIn",
      detail: "Reachable via LinkedIn.",
      weight: 4,
    });
  }

  signals.sort((a, b) => b.weight - a.weight);

  // --- breadth ---
  //
  // Weight alone rewards one heavy overlap as much as several light ones, and
  // those are not equally promising. Someone who shares your school AND your
  // year AND a club has three separate things to open with; someone who only
  // went to the same school has one, however heavily it scores.
  //
  // "Reachable" is excluded on purpose: having an email address is a property
  // of the record, not something the two of them have in common, and counting
  // it would hand a bonus to every contact that happens to be enriched.
  const shared = new Set(
    signals.filter((sig) => sig.kind !== "reachable").map((sig) => sig.kind),
  );
  const breadth = Math.min(Math.max(shared.size - 1, 0) * BREADTH_POINTS, BREADTH_MAX);

  if (breadth > 0) {
    signals.push({
      kind: "breadth",
      label: `${shared.size} kinds of overlap`,
      detail: `${shared.size} separate things in common, not one`,
      weight: breadth,
    });
  }

  const score = signals.reduce((n, sig) => n + sig.weight, 0);

  return { score, signals, band: score >= 60 ? "strong" : score >= 25 ? "warm" : "cold" };
}

export const BAND_LABELS: Record<ResponseLikelihood["band"], string> = {
  strong: "Strong match",
  warm: "Worth a note",
  cold: "Cold outreach",
};
