/**
 * What a returned contact and the student who paid for them have in common.
 *
 * The search finds people at the right firm in the right seat. This decides
 * which of those people the student should actually email first, and gives
 * them the opening line - because "we were both in Trojan Investing Society"
 * is the whole difference between a cold email and a warm one.
 *
 * It is deliberately deterministic. No model call: the comparison is set
 * intersection on fields we already hold, so it costs nothing, returns the
 * same answer twice, and can be read by a student who wants to know why we
 * suggested someone.
 *
 * Hometown, clubs and interests are compared HERE against what the provider
 * returns. Today it returns none of them (crustdata-client maps them to
 * null), so these overlaps are reported as unknown rather than scored - see
 * the signal audit in lib/contact-pool. Being found by an affinity search on
 * one of them is retrieval provenance, never evidence for this comparison.
 */

import { providerCityName } from "@/lib/city-spelling";
import { expandClub } from "@/lib/club-signals";
import { sameSchool as sameSchoolAnywhere } from "@/lib/school-name";

export type SimilarityKind =
  | "school"
  /** Graduated near the same year - the strongest signal after the school itself. */
  | "cohort"
  | "club"
  | "hometown"
  /** Studied in the same city, which is often not where either of them works. */
  | "school_city"
  /** Works in a city the student is targeting. */
  | "city"
  | "employer"
  | "major"
  | "interest";

export type Similarity = {
  kind: SimilarityKind;
  /** The shared thing itself, in the contact's spelling. */
  label: string;
  /** How it reads in the memo. */
  note: string;
  weight: number;
};

/**
 * A contact as we hold them after a search, normalised.
 *
 * This is OUR shape, not a provider's. Whatever comes back gets mapped onto
 * this first, so the comparison never has to care whose API returned it.
 */
export type ReturnedContact = {
  name: string;
  title?: string | null;
  school?: string | null;
  /**
   * Every school on the profile, where the provider gives us more than one.
   * The student's match is often the second degree on the page, so comparing
   * only the first quietly misses real alumni.
   */
  schools?: string[] | null;
  /** Their most recent graduation year. */
  gradYear?: number | null;
  /** The cities they studied in. */
  schoolCities?: string[] | null;
  /** Where they work now. Never read as a hometown - see the note on `hometown`. */
  currentCity?: string | null;
  major?: string | null;
  hometown?: string | null;
  clubs?: string[] | null;
  interests?: string[] | null;
  previousCompanies?: string[] | null;
};

/** The student's side of the comparison. */
export type StudentProfile = {
  school?: string | null;
  /**
   * The exact names the search matched the school on (lib/school-search-names).
   * A contact listing any of them shares the school - including names the
   * nickname table cannot read, like LinkedIn's "University of Michigan -
   * Stephen M. Ross School of Business", which it took for another school.
   */
  schoolNames?: string[] | null;
  /** The student's own graduation year, for cohort distance. */
  gradYear?: number | null;
  major?: string | null;
  /** Cities the student wants to work in. */
  targetCities?: string[] | null;
  hometown?: string | null;
  clubs?: string[] | null;
  interests?: string[] | null;
  priorEmployers?: string[] | null;
};

export type ContactAffinity = {
  matches: Similarity[];
  score: number;
  /** Short, human, and safe to render next to the contact. Empty when nothing matched. */
  memo: string;
};

/**
 * Relative worth of each kind of overlap.
 *
 * A shared school opens the door; a shared club means they probably know the
 * same people. An interest is real but weak on its own - plenty of bankers
 * ski.
 */
const WEIGHTS: Record<SimilarityKind, number> = {
  school: 5,
  // Deliberately just under the school. Once every result shares the school -
  // which it does, because we filter on it - this is what actually separates a
  // useful contact from a useless one.
  cohort: 4,
  club: 4,
  hometown: 3,
  employer: 3,
  school_city: 2,
  // Every result shares this, because the search filters on it - so it never
  // moves the ranking. It is in the memo anyway: a student choosing who to
  // write to still wants to see that this person is in the city they are
  // trying to get to, and the fact being common does not make it uninteresting.
  city: 2,
  major: 2,
  interest: 1,
};

/** Beyond this many years apart, a shared school stops meaning shared experience. */
const COHORT_YEARS = 5;

function key(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Case and punctuation aside, are these the same thing? */
function same(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return key(a) === key(b);
}

/**
 * Schools are written a dozen ways and exact equality misses most of them.
 * "University of Southern California - Marshall School of Business" is the
 * same school as "University of Southern California", and "USC Marshall" is
 * too. Getting this wrong drops real alumni, which is the one match this
 * whole product is built on.
 */
/**
 * The same school, however either side wrote it - the one comparison the app
 * uses (lib/school-name.ts): nicknames, a school within its university, and
 * never across campuses or lookalikes ("Penn State", "UNC Charlotte").
 */
function sameSchool(mine: string | null | undefined, theirs: string | null | undefined): boolean {
  return sameSchoolAnywhere(mine, theirs);
}

/** Overlap between two lists, returned in the contact's spelling. */
function shared(mine: string[] | null | undefined, theirs: string[] | null | undefined): string[] {
  if (!mine?.length || !theirs?.length) return [];
  const set = new Set(mine.map(key));
  return theirs.filter((item) => set.has(key(item)));
}

/**
 * A hometown match should survive "Boise, Idaho" vs "Boise, ID" vs "Boise".
 * The city is the part that matters; the state is how people disambiguate it.
 */
function sameCity(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (same(a, b)) return true;
  const city = (v: string) => key(v.split(",")[0] ?? "");
  return !!city(a) && city(a) === city(b);
}

export function compareContact(input: {
  student: StudentProfile;
  contact: ReturnedContact;
}): ContactAffinity {
  const { student, contact } = input;
  const matches: Similarity[] = [];

  const add = (kind: SimilarityKind, label: string, note: string) => {
    matches.push({ kind, label, note, weight: WEIGHTS[kind] });
  };

  const theirSchools = [contact.school, ...(contact.schools ?? [])].filter(
    (s): s is string => !!s,
  );
  // How close they were to being classmates.
  //
  // This carries most of the weight once a search filters on the school, which
  // ours does - every result shares it, so the school alone says nothing about
  // WHICH of them to email. Someone two years ahead sat the same interviews
  // with the same people; someone twelve years ahead is a different generation
  // of the firm.
  if (student.gradYear && contact.gradYear) {
    const gap = contact.gradYear - student.gradYear;
    if (Math.abs(gap) <= COHORT_YEARS) {
      const years = Math.abs(gap);
      add(
        "cohort",
        String(contact.gradYear),
        years === 0
          ? `Same graduating year (${contact.gradYear})`
          : gap < 0
            ? `Graduated ${years} year${years === 1 ? "" : "s"} ahead of you (${contact.gradYear})`
            : `Graduating ${years} year${years === 1 ? "" : "s"} after you (${contact.gradYear})`,
      );
    }
  }

  // Studied in the same place. Independent of where either of them works now,
  // so it survives the location filter having already matched everyone.
  // Through the same translation the location FILTER uses, so the two agree:
  // our chip says "New York City", every provider says "New York".
  const sharedSchoolCity = (contact.schoolCities ?? []).find((city) =>
    (student.targetCities ?? []).some((mine) => sameCity(providerCityName(mine), city)),
  );
  if (sharedSchoolCity) {
    add("school_city", sharedSchoolCity, `Studied in ${sharedSchoolCity}`);
  }

  // Where they work now, against where the student wants to work.
  const targetCity = (student.targetCities ?? []).find((mine) =>
    sameCity(providerCityName(mine), contact.currentCity),
  );
  if (targetCity) add("city", targetCity, `Works in ${targetCity}`);

  const exactNames = new Set((student.schoolNames ?? []).map((n) => n.trim().toLowerCase()));
  const sharedSchool = theirSchools.find(
    (school) => exactNames.has(school.trim().toLowerCase()) || sameSchool(student.school, school),
  );
  if (sharedSchool && student.school) {
    // Always the student's own spelling. Theirs may be a department, a campus
    // or an abbreviation; the student is reading this, so use the name they
    // wrote for their own school.
    add("school", student.school, `Also ${student.school}`);
  }

  // Both sides expand to every spelling, so a student who wrote "TIS" still
  // matches a contact who wrote "Trojan Investing Society". The comparison is
  // between GROUPS of spellings rather than strings - matching strings counts
  // one shared club twice, once per spelling that happens to line up.
  const theirClubs = (contact.clubs ?? []).map((club) => ({
    label: club,
    keys: new Set(expandClub(club).map(key)),
  }));
  const claimed = new Set<number>();

  for (const mine of student.clubs ?? []) {
    const mineKeys = expandClub(mine).map(key);
    const hit = theirClubs.findIndex(
      (theirs, i) => !claimed.has(i) && mineKeys.some((k) => theirs.keys.has(k)),
    );
    if (hit === -1) continue;
    claimed.add(hit);
    // Their spelling, because the memo is about the person being introduced.
    add("club", theirClubs[hit].label, `Both in ${theirClubs[hit].label}`);
  }

  if (sameCity(student.hometown, contact.hometown) && contact.hometown) {
    add("hometown", contact.hometown, `Both from ${contact.hometown.split(",")[0]?.trim()}`);
  }

  for (const employer of shared(student.priorEmployers, contact.previousCompanies)) {
    add("employer", employer, `Also worked at ${employer}`);
  }

  if (same(student.major, contact.major) && contact.major) {
    add("major", contact.major, `Also studied ${contact.major}`);
  }

  for (const interest of shared(student.interests, contact.interests)) {
    add("interest", interest, `Also into ${interest.toLowerCase()}`);
  }

  matches.sort((a, b) => b.weight - a.weight);

  return {
    matches,
    score: matches.reduce((sum, m) => sum + m.weight, 0),
    memo: buildMemo(matches),
  };
}

/** How many overlaps fit in a line a student will actually read. */
const MEMO_ITEMS = 3;
const MEMO_CHARS = 160;

function buildMemo(matches: Similarity[]): string {
  // The school is deliberately absent.
  //
  // It has a column of its own, and the search filters on it, so every memo
  // used to open with the same words - "Also University of Southern
  // California" - and pushed the things that actually differ between two
  // candidates out of the three slots there are. Dropping it here promotes the
  // cohort, the city and the club into view.
  //
  // It stays in `matches` and in `score`: it is still the heaviest signal and
  // still decides the ranking. This is about what the line SAYS, not what it
  // counts.
  const sayable = matches.filter((m) => m.kind !== "school");
  if (!sayable.length) return "";
  const memo = sayable.slice(0, MEMO_ITEMS).map((m) => m.note).join(" · ");
  return memo.length > MEMO_CHARS ? `${memo.slice(0, MEMO_CHARS - 1).trimEnd()}…` : memo;
}

/** Best first. Ties keep provider order, which is their own relevance ranking. */
export function rankContacts<T extends ReturnedContact>(
  student: StudentProfile,
  contacts: T[],
): { contact: T; affinity: ContactAffinity }[] {
  return contacts
    .map((contact) => ({ contact, affinity: compareContact({ student, contact }) }))
    .sort((a, b) => b.affinity.score - a.affinity.score);
}
