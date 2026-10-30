import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { contacts, firms, users } from "@/db/schema";
import { clubSignals } from "@/lib/club-signals";
import { CONTACTS_PER_RUN } from "@/lib/contact-credits";
import { interestGroups } from "@/lib/coverage-match";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";
import { resumeSignals } from "@/lib/resume-signals";
import { businessSchoolNames, fallbackSchoolNames } from "@/lib/school-search-names";
import { schoolSearchFor } from "@/lib/school-search-resolution";

/**
 * The contact-sourcing agent.
 *
 * It assembles what we know about one student from three places - their
 * onboarding answers, their resume, and their LinkedIn URL - and turns it into
 * (a) a search to send a people-data provider, and (b) the signals we use
 * ourselves to rank whatever comes back.
 *
 * HOMETOWN AND INTERESTS MAY BE SENT (owner's decision, 8 October 2026). The
 * student's clubs, interests - resume and typed - coverage and hometown are
 * the raw material for up to three separate affinity searches per run
 * (lib/contact-pool buildAffinitySignals), each sending one signal as
 * free text. They used to be held back behind the public-profile toggles;
 * those toggles now decide only what other students see. Affinity searching
 * is OFF unless CONTACT_AFFINITY_SEARCH=on (lib/contact-search-provider), so
 * by default none of this leaves Offerly.
 *
 * Resume TEXT stays local. A people search needs the firm, the titles and the
 * keywords above, not the student's coursework.
 *
 * ON LINKEDIN. We do not read the student's LinkedIn ourselves: public
 * profiles sit behind an auth wall for automated clients, fetching one while
 * signed in as the student risks their account, and the provider's own data is
 * LinkedIn-derived anyway. The URL is passed through so the provider can
 * resolve the person it already has.
 */

/** Everything the agent knows. Stays on our side. */
export type StudentDossier = {
  identity: {
    name: string | null;
    school: string | null;
    major: string | null;
    gradYear: number | null;
    /** Private. Ranking only - never sent out. */
    hometown: string | null;
  };
  targeting: {
    sectors: string[];
    sectorLabels: string[];
    coverage: string[];
    ibTiers: string[];
    peTiers: string[];
    locations: string[];
    recruitingStage: string | null;
  };
  background: {
    clubs: string | null;
    priorExperience: string[];
    /** Private. Ranking only - never sent out. */
    interests: string | null;
    proudExperience: string | null;
    workStyle: string | null;
  };
  resume: {
    present: boolean;
    chars: number;
    /** Read back out of the stored summary - the resume already lists these. */
    interests: string[];
    skills: string[];
    employers: string[];
    activities: string[];
  };
  linkedinUrl: string | null;
  /**
   * What the student has agreed may leave the private side of their profile.
   *
   * These are the app's own toggles, not a new idea: hometown and interests are
   * private matching input until the student flips them. Reusing them means
   * "shared with a third party to find contacts" is governed by the same switch
   * as "shown on my public profile", rather than by a second, invisible rule.
   */
  consent: { shareHometown: boolean; shareInterests: boolean };
};

/** The outbound payload. Deliberately narrow - see the note above. */
/**
 * One people search, in the provider's own shape.
 *
 * Grouped to mirror Crustdata's field taxonomy - `employer.*` is
 * experience.employment_details.current.*, `education.*` is
 * education.schools.*, `location.*` is basic_profile.location.* - so the
 * translation in crustdata-client.ts is a rename rather than a rethink, and a
 * field that has no home here is a field they cannot read.
 *
 * EVERY FIELD HERE IS ACTUALLY SENT. Two previous fields (`gradYearWithin`,
 * `seniority`) sat in this payload looking like filters while reaching nobody,
 * so the rule now is: if it is in this type, it goes on the wire. Things they
 * cannot filter on go in `keywords`, which is honest about being a hint.
 */
export type ContactSearchQuery = {
  /** experience.employment_details.current.* - the firm they work at now. */
  employer: {
    name: string;
    /** company_website_domain. Beats a name match: a name also finds people who merely typed it. */
    domain: string;
    /**
     * The firm's VERIFIED provider company id (lib/company-resolution), set by
     * the run once the firm is resolved. When present the search filters on it
     * directly instead of looking the company up again - which picked
     * "Greenhill Development Co" off greenhill.com and searched a company with
     * no bankers in it.
     */
    companyId?: number | null;
  };

  person: {
    /**
     * current.title, matched as "contains all these words".
     *
     * FUNCTION WORDS ONLY - "Investment Banking", "M&A". Seniority words match
     * every department at a bank and returned Legal Analysts and HR Business
     * Partners when they lived here.
     */
    titleAnyOf: string[];
    /** current.seniority_level, in THEIR vocabulary - see SENIORITY_TO_PROVIDER. */
    seniorityLevels: string[];
    /** years_of_experience_raw, upper bound. */
    maxYearsExperience: number;
  };

  /** education.schools.* */
  education: {
    /**
     * The student's school: `names` is sent, each as an EXACT match on
     * education.schools.school (any one of them); `label` is what the run log
     * and the student read. Exact because a word match on "University of
     * Pennsylvania" also returns Indiana University of Pennsylvania and five
     * other schools - see lib/school-search-names.
     */
    school: {
      label: string;
      names: string[];
      /** The subset that is the school's business school - searched first. */
      businessNames: string[];
    } | null;
    /** end_year, lower bound. Keeps alumni recent enough to remember being a student. */
    graduatedOnOrAfter: number | null;
  };

  /** basic_profile.location.city */
  location: { cities: string[] };

  /**
   * search.query - the free-text half.
   *
   * Everything real about a student that Crustdata has NO field for: clubs,
   * interests, coverage group, hometown. Measured: coverage in `title` and in
   * `description` both return zero, so these cannot be filters. Here they
   * influence ranking instead of excluding people, which is the honest use of
   * a signal the provider cannot index.
   */
  keywords: string[];

  /** Already saved at this firm, so a second click returns NEW people. */
  exclude: { linkedinUrls: string[]; names: string[] };

  limit: number;

  /** Not sent. Provenance for the UI: did we search the sector the student picked? */
  matchedStudentSector: boolean;
};

/** What we rank returned contacts on. Never leaves the server. */
type AffinitySignals = {
  school: string | null;
  major: string | null;
  hometown: string | null;
  clubs: string | null;
  interests: string | null;
  priorEmployers: string[];
};

export type SourcingPlan = {
  firm: { id: string; name: string; slug: string; website: string };
  dossier: StudentDossier;
  query: ContactSearchQuery;
  affinity: AffinitySignals;
  /** One line for the run log, so a past run can be explained later. */
  summary: string;
  /** Inputs a better search would have had. Surfaced in the UI, not fatal. */
  missing: string[];
};

/** Alumni older than this have usually moved off the desk a student is asking
 *  about, and are far less likely to reply to an undergraduate. */
/**
 * The most career a contact can have and still be worth a student's email.
 *
 * Matched to the twenty-year graduation window below - the two were 12 and 20,
 * and the tighter one silently decided the result, so widening the window
 * alone changed nothing. Seniority is what actually keeps MDs out; this is
 * just the outer edge.
 */
const ALUMNI_WINDOW_YEARS = 20;

/**
 * How far back the alumni window reaches, counted from the day of the click
 * rather than from the student's own graduation.
 *
 * Anchoring to "now" means the window does not slide with whoever is
 * searching: a freshman and a senior looking at the same firm on the same day
 * see the same span of alumni.
 */
const ALUMNI_YEARS_BEFORE_CLICK = 20;

/**
 * Titles to ask for, by business.
 *
 * Not one list for everything: "Investment Banking Analyst" is the wrong
 * search at a private equity fund, where the equivalent seat is an Associate.
 */
/**
 * WHAT someone does, never how senior they are.
 *
 * These two were one list until a search returned a Legal Analyst and an HR
 * Business Partner: "Analyst" and "Associate" are seniority words, and every
 * department at a bank has them. Matching on them finds the whole firm.
 *
 * Seniority is a separate filter now (SENIORITY_BY_CATEGORY), because the
 * provider models it separately - and measured at Goldman, function words plus
 * a seniority filter returned four real IB analysts in the top five, where
 * seniority alone returned software engineers.
 */
const TITLES_BY_CATEGORY: Partial<Record<FirmProgramCategory, string[]>> = {
  investment_banking: [
    "Investment Banking",
    "M&A",
    "Mergers and Acquisitions",
    "Leveraged Finance",
    "Capital Markets",
  ],
  private_equity: ["Private Equity", "Buyout", "Growth Equity"],
  venture_capital: ["Venture Capital", "Venture", "Investor"],
  private_credit: ["Private Credit", "Direct Lending", "Credit Investing"],
  real_estate: ["Real Estate", "Real Estate Acquisitions"],
  hedge_fund: ["Equity Research", "Investment Analyst", "Portfolio Management"],
  sales_trading: ["Sales and Trading", "Trading", "Trader"],
  asset_wealth_management: ["Asset Management", "Wealth Management", "Portfolio Management"],
  consulting: ["Consulting", "Strategy Consulting", "Management Consultant"],
};

/**
 * No category means no function to search on. Empty rather than a seniority
 * ladder: a title filter we cannot fill correctly is worse than none, because
 * the seniority filter already bounds the result and a wrong value here
 * silently excludes the right people.
 */
const DEFAULT_TITLES: string[] = [];

export function titlesFor(category: FirmProgramCategory | null): string[] {
  return (category && TITLES_BY_CATEGORY[category]) || DEFAULT_TITLES;
}

/**
 * TITLES_BY_CATEGORY normalised to levels.
 *
 * People-data providers split on this: some filter by job title string, some
 * by a seniority enum. Sending both means the mapping layer can use whichever
 * the endpoint supports without re-deriving it. These are OUR values - they
 * still have to be mapped onto the provider's enum.
 */
const SENIORITY_BY_CATEGORY: Partial<Record<FirmProgramCategory, string[]>> = {
  investment_banking: ["analyst", "associate"],
  // Analysts too: the megafunds run analyst programs, and a first-year analyst
  // is the person a student is closest to. Without them, 268 Penn alumni at
  // Blackstone narrowed to 8 on seniority alone.
  private_equity: ["analyst", "associate", "senior_associate"],
  venture_capital: ["associate", "principal"],
  private_credit: ["analyst", "associate"],
  real_estate: ["analyst", "associate"],
  hedge_fund: ["analyst", "associate"],
  sales_trading: ["analyst", "associate"],
  asset_wealth_management: ["analyst", "associate"],
  consulting: ["analyst", "consultant"],
};

/**
 * Deliberately stops at associate. Vice presidents and above were in this list
 * and were what came back - and a VP does not answer a sophomore. The seats
 * that reply are the ones a student is nearly peers with.
 */
const DEFAULT_SENIORITY = ["analyst", "associate"];

export function seniorityFor(category: FirmProgramCategory | null): string[] {
  return (category && SENIORITY_BY_CATEGORY[category]) || DEFAULT_SENIORITY;
}

/** Firms a student has already worked at - useful ranking signal, and the one
 *  part of a resume worth carrying. */
export function employersFrom(priorExperience: string[] | null): string[] {
  return (priorExperience ?? []).map((e) => e.trim()).filter(Boolean).slice(0, 8);
}

/**
 * The outbound payload, built from the dossier.
 *
 * Pure and exported so the privacy boundary can be TESTED rather than merely
 * commented: a test hands it a dossier full of private fields and asserts none
 * of them survive into the payload. Reading each field by name, rather than
 * spreading the dossier and deleting what we do not want, is what makes that
 * hold - a field added to the dossier later cannot leak by default.
 */
export function buildSearchQuery(input: {
  dossier: StudentDossier;
  /** The school's exact names, resolved from the student's school id. When
   *  absent, the typed school and its full name from our nickname table. */
  school?: { label: string; names: string[] } | null;
  firm: { name: string; website: string };
  category: FirmProgramCategory | null;
  limit: number;
  existing: { name: string; linkedinUrl: string | null }[];
}): ContactSearchQuery {
  const { dossier, firm, category, limit, existing } = input;
  const typed = dossier.identity.school;
  const resolved =
    input.school !== undefined
      ? input.school
      : typed
        ? { label: typed, names: fallbackSchoolNames(typed) }
        : null;
  const school = resolved ? { ...resolved, businessNames: businessSchoolNames(resolved.names) } : null;

  return {
    employer: { name: firm.name, domain: firm.website },

    person: {
      titleAnyOf: titlesFor(category),
      seniorityLevels: seniorityFor(category),
      maxYearsExperience: ALUMNI_WINDOW_YEARS,
    },

    education: {
      school,
      graduatedOnOrAfter: alumniSince(),
    },

    location: { cities: dossier.targeting.locations },

    // Everything Crustdata holds no field for. Never sent by the baseline
    // ladder; affinity searches send one signal each when enabled (see the
    // note at the top of this file).
    keywords: [
      ...dossier.targeting.coverage,
      ...clubSignals({
        offerly: dossier.background.clubs,
        resume: dossier.resume.activities,
      }),
      ...interestHooks(dossier),
      ...(dossier.identity.hometown ? [dossier.identity.hometown] : []),
    ]
      .map((k) => k.trim())
      .filter(Boolean),

    exclude: {
      linkedinUrls: existing.map((c) => c.linkedinUrl).filter((v): v is string => !!v),
      names: existing.map((c) => c.name),
    },

    limit,
    matchedStudentSector: !!category && dossier.targeting.sectors.includes(category),
  };
}

/**
 * The earliest graduation year worth returning.
 *
 * Twenty years before the click. Not relative to the student's own year: two
 * students searching the same firm on the same day should see the same pool,
 * and a freshman is not entitled to a narrower one than a senior.
 *
 * Takes `now` so the boundary is testable without freezing the clock.
 */
export function alumniSince(now: Date = new Date()): number {
  return now.getFullYear() - ALUMNI_YEARS_BEFORE_CLICK;
}

/**
 * The student's interests, for finding shared ground with a contact.
 *
 * Both sources travel: the resume's interests section and the typed
 * `users.interests` field. The typed field used to be held back behind
 * showInterestsOnProfile; since 8 October 2026 that toggle decides only what
 * other students see, not what the contact search may use.
 */
export function interestHooks(dossier: StudentDossier): string[] {
  return [
    ...dossier.resume.interests,
    ...splitInterests(dossier.background.interests),
  ]
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v, i, all) => all.findIndex((o) => o.toLowerCase() === v.toLowerCase()) === i)
    .slice(0, 8);
}

/** "college football, poker, hiking" -> three searchable hooks. */
export function splitInterests(value: string | null): string[] {
  return (value ?? "")
    .split(/[,;/|\n]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export class SourcingContextError extends Error {}

export async function buildSourcingPlan(input: {
  userId: string;
  firmId: string;
  /** Which business at the firm. Defaults to the overlap between what the firm
   *  runs and what the student is recruiting for. */
  category?: FirmProgramCategory;
  limit?: number;
}): Promise<SourcingPlan> {
  const db = await getDb();

  const user = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
  if (!user) throw new SourcingContextError("No signed-in student.");

  const firm = await db.query.firms.findFirst({
    where: eq(firms.id, input.firmId),
    with: { programs: { columns: { category: true } } },
    columns: { id: true, name: true, slug: true, website: true },
  });
  if (!firm) throw new SourcingContextError("That firm no longer exists.");

  // Everything the student already has at this firm, so a second click returns
  // five NEW people rather than paying again for the same five.
  const existing = await db.query.contacts.findMany({
    where: and(eq(contacts.userId, input.userId), eq(contacts.firm, firm.name)),
    columns: { name: true, linkedinUrl: true },
  });

  const sectors = user.preferredCategories ?? [];
  const firmCategories = firm.programs.map((p) => p.category as FirmProgramCategory);
  const category =
    input.category ??
    (firmCategories.find((c) => sectors.includes(c)) ?? firmCategories[0] ?? null);

  const coverage = interestGroups(user.nicheInterests);

  const dossier: StudentDossier = {
    identity: {
      name: user.name ?? null,
      school: user.school ?? null,
      major: user.major ?? null,
      gradYear: user.gradYear ?? null,
      hometown: user.hometown ?? null,
    },
    targeting: {
      sectors,
      sectorLabels: sectors.map((s) => CATEGORY_LABELS[s as FirmProgramCategory] ?? s),
      coverage,
      ibTiers: user.ibTierPreferences ?? [],
      peTiers: user.peTierPreferences ?? [],
      locations: user.targetLocations ?? [],
      recruitingStage: user.recruitingStage ?? null,
    },
    background: {
      clubs: user.clubsAndActivities ?? null,
      priorExperience: user.priorExperience ?? [],
      interests: user.interests ?? null,
      proudExperience: user.proudExperience ?? null,
      workStyle: user.workStyle ?? null,
    },
    resume: {
      present: !!user.resumeText,
      chars: user.resumeText?.length ?? 0,
      ...resumeSignals(user.resumeText),
    },
    linkedinUrl: user.linkedinUrl ?? null,
    consent: {
      shareHometown: !!user.showHometownOnProfile,
      shareInterests: !!user.showInterestsOnProfile,
    },
  };

  const query = buildSearchQuery({
    dossier,
    school: await schoolSearchFor(user),
    firm: { name: firm.name, website: firm.website },
    category,
    limit: input.limit ?? CONTACTS_PER_RUN,
    existing,
  });

  const affinity: AffinitySignals = {
    school: dossier.identity.school,
    major: dossier.identity.major,
    hometown: dossier.identity.hometown,
    clubs: dossier.background.clubs,
    interests: dossier.background.interests,
    // The resume is the better record of where someone has worked; the
    // onboarding answer fills in when there is no resume on file.
    priorEmployers: dossier.resume.employers.length
      ? dossier.resume.employers
      : employersFrom(user.priorExperience),
  };

  const missing = [
    !dossier.resume.present && "resume",
    !dossier.linkedinUrl && "LinkedIn profile",
    !dossier.identity.school && "school",
  ].filter((v): v is string => typeof v === "string");

  const where = query.location.cities.length ? ` in ${query.location.cities.join(", ")}` : "";
  const group = dossier.targeting.coverage.length
    ? ` (${dossier.targeting.coverage.join("/")})`
    : "";
  const label = category ? (CATEGORY_LABELS[category] ?? null) : null;
  const desk = label ? `${label} at ` : "";
  const alumni = query.education.school
    ? `, favouring ${query.education.school.label} alumni`
    : "";
  const summary =
    `${query.limit} contacts in ${desk}${firm.name}${group}${where}${alumni}` +
    (query.exclude.names.length ? ` (excluding ${query.exclude.names.length} already saved)` : "");

  return { firm, dossier, query, affinity, summary, missing };
}
