import type { FirmProgramCategory } from "./firm-metadata";
import { COUNTRY_OPTIONS } from "./countries";

// The onboarding question bank.
//
// Design constraints this encodes, and why:
//
// 1. The AI firm matcher (lib/find-top-firms.ts) already reads free text -
//    school, interests, motivations, work style. Chip answers narrow the
//    CANDIDATE SET; prose is what lets the model pick well within it. So the
//    bank deliberately mixes both rather than being all chips.
//
// 2. Most users are new to recruiting and genuinely do not know the answer to
//    "which coverage group do you want?". Every non-essential question
//    therefore carries an explicit "not sure yet" choice, and choosing it is
//    RECORDED rather than skipped (see UNSURE). A recorded "undecided" is real
//    signal: it tells the matcher to favour firms with broad/rotational
//    exposure, and tells the app to surface Discovery content instead of
//    pretending the student has a view they don't have.
//
// 3. Only the `core` section gates the dashboard. `deep` is optional and
//    framed as sharpening matches, so beginners are never blocked by a
//    question they cannot answer.

export const UNSURE = "__unsure__";

// "combobox" is a typed box that only accepts one of `options` - for lists far
// too long to show as chips, like every country.
type QuestionKind = "multi" | "single" | "text" | "longtext" | "combobox";

export type OnboardingQuestion = {
  /** Maps to a column on `users`, except the per-sector dynamic questions. */
  key: string;
  section: "core" | "deep";
  kind: QuestionKind;
  title: string;
  subtitle?: string;
  /**
   * A typed box rendered underneath this question's options.
   *
   * Its answer is stored under its OWN key, so it saves through the same path
   * as any other answer and needs no special case in the action. The only
   * thing that is special is where it appears: inside another question,
   * because "which degree" and "which exactly" are one thought and splitting
   * them across two screens makes the second look like a different subject.
   */
  followUp?: { key: string; label: string; placeholder: string; maxLength?: number };
  /** For multi/single. */
  options?: string[];
  /** For text/longtext. */
  placeholder?: string;
  /** Wording for the "I don't know" escape hatch. Omit to hide it. */
  unsureLabel?: string;
  /** Gate on sectors picked earlier, so the wizard stays as short as it can. */
  showIf?: (categories: FirmProgramCategory[]) => boolean;
  /** Blocks Next until answered. Only ever true inside `core`. */
  required?: boolean;
  maxLength?: number;
};

const NOT_SURE = "I'm not sure yet";

// ---------------------------------------------------------------- core ----

export const CORE_QUESTIONS: OnboardingQuestion[] = [
  {
    key: "degreeLevel",
    section: "core",
    kind: "single",
    required: true,
    title: "Which degree are you enrolled in?",
    // The one "what do you study" box. There used to be two - this one saved
    // to degreeProgram and a later "What are you studying?" saved to major -
    // and students typed the same answer twice. major is the one peer
    // matching and outreach read, so this box saves there.
    followUp: {
      key: "major",
      label: "What are you studying?",
      placeholder: "e.g. Business Administration, Financial Engineering",
      maxLength: 120,
    },
    subtitle:
      "Banks run separate programmes per degree and they do not overlap - a Summer Analyst seat is undergraduates only, a Summer Associate seat is MBA and advanced master's only. This is what keeps postings you cannot apply to off your list.",
    // Stored as the label; normalizeDegreeLevel (lib/degree-fit) reads it.
    options: ["Bachelor's", "Master's or MBA", "PhD"],
  },
  // Optional, on the degree screen: GPA is a fact about the degree, and
  // asked on its own screen at the end it read as a question from nowhere.
  {
    // Stored in gpa_band for history's sake; it holds the exact GPA now, not a range.
    key: "gpaBand",
    section: "core",
    kind: "text",
    title: "What's your cumulative GPA?",
    subtitle:
      "Never shown to anyone, and filled in from your resume when it lists one. Some programs publish a hard cutoff, and we'd rather flag that early than late.",
    placeholder: "e.g. 3.72",
    maxLength: 4,
  },
  {
    key: "gradYear",
    unsureLabel: NOT_SURE,
    section: "core",
    kind: "single",
    required: true,
    title: "When do you graduate?",
    subtitle:
      "The single most important answer here - finance recruits roughly 18 months early, so your class year decides which cycle is open to you.",
    // No "Graduate student": the degree question already asks that, and
    // picking it here threw away the year, which is the whole answer.
    options: ["2027", "2028", "2029", "2030", "Already graduated"],
  },
  {
    key: "targetInternshipYear",
    unsureLabel: NOT_SURE,
    section: "core",
    kind: "single",
    required: true,
    title: "Which summer are you trying to intern?",
    subtitle:
      "Usually the summer before your final year. This is what decides whether a posting is yours to apply to or last year's.",
    // Explicit summers rather than "junior year": the same class year means
    // different summers for five-year, dual-degree, gap-year and MBA students,
    // and those are precisely the people a gradYear - 1 guess gets wrong.
    options: ["Summer 2027", "Summer 2028", "Summer 2029", "Summer 2030"],
  },
  {
    key: "targetLocations",
    section: "core",
    kind: "multi",
    title: "Where would you genuinely consider working?",
    subtitle: "Pick every city you'd say yes to. Being open to more cities meaningfully widens your options.",
    unsureLabel: "Open to anywhere",
  },
];

// --------------------------------------------------------- optional -----

// Where a student is from, and whether they need a visa - asked on ONE page
// after the gate. They used to be a page per answer, which made the optional
// part feel longer than the required part.
const OPTIONAL_QUESTIONS: OnboardingQuestion[] = [
  {
    key: "hometown",
    unsureLabel: "Rather not say",
    section: "deep",
    kind: "text",
    title: "Where are you from?",
    subtitle: "Regional ties come up constantly in networking, and some offices recruit their local area harder.",
    placeholder: "e.g. Dallas, TX",
    maxLength: 120,
  },
  {
    // Its own answer rather than folded into hometown: "Where are you from?"
    // is free text, and matching students and alumni by country needs one
    // spelling per country - so this only takes a name from the list.
    key: "homeCountry",
    section: "deep",
    kind: "combobox",
    title: "Which country?",
    placeholder: "Start typing a country",
    options: [...COUNTRY_OPTIONS],
  },
  {
    key: "sponsorshipNeeded",
    unsureLabel: NOT_SURE,
    section: "deep",
    kind: "single",
    title: "Will you need visa sponsorship to work in the US?",
    subtitle:
      "Some programs state their sponsorship policy up front - knowing this stops us recommending roles you aren't eligible for.",
    options: ["No", "Yes", "Prefer not to say"],
  },
];

// --------------------------------------------------------- assembly -----

/** Per-sector questions (tier + niche) are injected by the wizard between
 *  these, since they depend on which sectors were picked. */
export const QUESTION_SECTIONS: { id: string; label: string; blurb: string; questions: OnboardingQuestion[] }[] = [
  {
    id: "optional",
    label: "A few more details",
    blurb: "All optional - skip anything you'd rather not answer.",
    questions: OPTIONAL_QUESTIONS,
  },
];

export const ALL_DEEP_QUESTIONS: OnboardingQuestion[] = QUESTION_SECTIONS.flatMap((s) => s.questions);

/** Keys that live on `users` as plain text/single-value columns. */
export const SINGLE_VALUE_KEYS = [
  // Already a column on `users` and already saved by the profile page's
  // AccountForm - onboarding simply never asked, which is why it was null on
  // every account. Same property, one more place to fill it in.
  "major",
  "hometown",
  "sponsorshipNeeded",
  "gpaBand",
  "degreeLevel",
  "homeCountry",
] as const;

/** Keys stored as text[]. */
export const ARRAY_KEYS = ["targetLocations"] as const;

// Column/question keys rendered as plain English, so a prompt says "which
// coverage group they want" rather than leaking `nicheInterests`.
export const UNSURE_QUESTION_LABELS: Record<string, string> = {
  preferredCategories: "which sector of finance they want",
  ibTierPreferences: "what type of investment bank they want (bulge bracket vs. boutique vs. middle-market)",
  peTierPreferences: "what type of fund they want",
  nicheInterests: "which product or coverage group they want",
  targetLocations: "where they want to work",
  technicalReadiness: "how prepared they are technically",
  workStyle: "what kind of work environment suits them",
  sponsorshipNeeded: "whether they need visa sponsorship",
};
