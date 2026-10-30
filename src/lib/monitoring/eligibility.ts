import "server-only";

/**
 * Who a posting is actually for - read out of its own words, not guessed from
 * its programme year.
 *
 * WHY THIS EXISTS
 * ---------------
 * `promote-approved-listings.ts` was publishing
 * `eligibleGradYears: [programYear, programYear + 1]` for every posting. That
 * is a guess wearing the costume of a fact, and it is wrong in both directions:
 * `programYear` itself is a graduation year that has already happened by the
 * time the internship runs, and a sophomore insight programme for the same
 * summer wants students graduating a year LATER than the range allows. A
 * student filtering by their own graduation year therefore saw programmes they
 * could not apply to and missed ones they could.
 *
 * Firms state this outright far more often than the old code assumed - "Class
 * of 2028", "rising junior", "penultimate year students" - so the answer is
 * usually there to be read.
 *
 * THE OFFSET
 * ----------
 * Undergraduate finance runs one dominant cycle: the internship that matters is
 * junior summer, the summer before final year. So for a Summer <Y> programme:
 *
 *   standard / junior summer  -> graduating Y + 1   (a rising senior)
 *   sophomore / insight       -> graduating Y + 2   (a rising junior)
 *   freshman / discovery      -> graduating Y + 3
 *
 * This mirrors lib/internship-year.ts's `targetProgramYear(gradYear) =
 * gradYear - 1` deliberately: the two must never disagree, because one decides
 * what a student is shown and the other decides what a posting claims to want.
 */

type StudentLevel = "freshman" | "sophomore" | "junior" | "senior" | "graduate";

export type Eligibility = {
  /** Graduation years this posting accepts. Empty when nothing could be read
   *  AND no programme year was available to infer from. */
  gradYears: number[];
  /** The year of study the posting names, when it names one. */
  level: StudentLevel | null;
  /**
   * How the answer was arrived at. `stated` means the posting said it;
   * `inferred` means it was derived from the programme year via the standard
   * path. A caller deciding whether to publish without a human should care
   * about the difference - an inference is a reasonable default, not a fact
   * about this employer.
   */
  basis: "stated" | "inferred" | "unknown";
  /** The text this was read out of, verbatim. Empty when inferred. */
  evidence: string[];
};

/** Years of study, longest and most specific phrasings first so "rising
 *  junior" is not consumed by a bare "junior" match. */
const LEVEL_PHRASES: { level: StudentLevel; offset: number; patterns: RegExp[] }[] = [
  {
    level: "sophomore",
    offset: 2,
    patterns: [
      /\brising\s+juniors?\b/i,
      /\bsophomores?\b/i,
      /\bsecond[- ]year\s+(students?|undergraduates?)\b/i,
      /\b2nd[- ]year\s+(students?|undergraduates?)\b/i,
      // The UK/European equivalent of a sophomore insight programme.
      /\bfirst[- ]year\s+(students?|undergraduates?)\b.*\b(insight|spring week)\b/i,
    ],
  },
  {
    level: "junior",
    offset: 1,
    patterns: [
      /\brising\s+seniors?\b/i,
      /\bpenultimate[- ]year\b/i,
      /\bjuniors?\b(?!\s+(analyst|associate|banker|developer|engineer))/i,
      /\bthird[- ]year\s+(students?|undergraduates?)\b/i,
      /\b3rd[- ]year\s+(students?|undergraduates?)\b/i,
    ],
  },
  {
    level: "freshman",
    offset: 3,
    patterns: [/\bfreshmen\b/i, /\bfreshman\b/i, /\bfirst[- ]year\s+(students?|undergraduates?)\b/i],
  },
  {
    level: "senior",
    offset: 0,
    patterns: [/\bfinal[- ]year\s+(students?|undergraduates?)\b/i, /\bgraduating\s+seniors?\b/i],
  },
  {
    level: "graduate",
    // Offset 1, not 0. An MBA summer associate interns between first and
    // second year and graduates the FOLLOWING spring - the same shape as an
    // undergraduate junior summer, one rung up. Offset 0 said a Summer 2027
    // associate graduates in 2027, which is the year they would already have
    // left, and would have hidden the posting from every student who could
    // actually apply.
    offset: 1,
    patterns: [/\b(mba|master'?s|postgraduate|phd)\b/i],
  },
];

/**
 * Graduation years the text names outright.
 *
 * Deliberately narrow. A bare four-digit year anywhere in a job description is
 * far more often the programme year, a founding date or a comp figure than a
 * graduation year, so a year only counts when it sits next to language that
 * makes it one - "Class of 2028", "graduating in 2028", "expected graduation
 * December 2028".
 */
function statedGradYears(text: string): { years: number[]; evidence: string[] } {
  const years = new Set<number>();
  const evidence: string[] = [];

  const patterns = [
    /\bclass(?:es)?\s+of\s+((?:20\d{2})(?:\s*(?:,|,?\s*(?:and|or|through|-|–|to)\s*)\s*20\d{2})*)/gi,
    /\bgraduat\w*\s+(?:in|by|between)?\s*((?:20\d{2})(?:\s*(?:,|,?\s*(?:and|or|through|-|–|to)\s*)\s*20\d{2})*)/gi,
    // "Anticipated graduation date: Fall 2027 - Spring 2028" is how PJT states
    // it, and the single-year version of this pattern read only the 2027 and
    // silently excluded every student graduating in 2028 - half the intended
    // audience. The window is wide enough to span a term-qualified range
    // ("Fall 2027 - Spring 2028") without running into the next sentence.
    /\b(?:expected|anticipated)\s+graduation[^.]{0,40}?((?:20\d{2})(?:[^.]{0,20}?20\d{2})?)/gi,
    /\bdegree\s+completion[^.]{0,40}?((?:20\d{2})(?:[^.]{0,20}?20\d{2})?)/gi,
    /\bgraduation\s+date[^.]{0,40}?((?:20\d{2})(?:[^.]{0,20}?20\d{2})?)/gi,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const found = m[1].match(/20\d{2}/g) ?? [];
      if (found.length === 0) continue;
      found.forEach((y) => years.add(Number(y)));
      evidence.push(m[0].trim().replace(/\s+/g, " ").slice(0, 120));
      // A range means every year between, not just the ends. Matched on the
      // separator appearing anywhere between the two years, because firms
      // qualify them by term - "Fall 2027 - Spring 2028", "December 2027
      // through May 2028" - rather than writing the years adjacently.
      if (found.length === 2 && /(?:through|-|–|—|to|and|\/)/i.test(m[0])) {
        const [a, b] = found.map(Number).sort((x, y) => x - y);
        for (let y = a; y <= b && y - a < 6; y++) years.add(y);
      }
    }
  }

  return { years: [...years].sort(), evidence };
}

/** The year of study a posting names, if any. */
function statedLevel(text: string): { level: StudentLevel; offset: number; evidence: string } | null {
  for (const entry of LEVEL_PHRASES) {
    for (const p of entry.patterns) {
      const m = p.exec(text);
      if (m) {
        return { level: entry.level, offset: entry.offset, evidence: m[0].trim().slice(0, 80) };
      }
    }
  }
  return null;
}

/**
 * Who can apply.
 *
 * `programYear` is the summer the internship runs. It is used only as the
 * anchor for an offset - never as a graduation year in its own right, which is
 * the bug this replaces.
 */
export function readEligibility(
  text: string,
  programYear: number | null,
): Eligibility {
  const haystack = text.slice(0, 8000); // requirements live near the top; the tail is boilerplate

  const stated = statedGradYears(haystack);
  const level = statedLevel(haystack);

  // An explicit "Class of ..." is the strongest signal there is - it is the
  // employer answering this exact question - so it wins outright.
  if (stated.years.length) {
    return {
      gradYears: stated.years,
      level: level?.level ?? null,
      basis: "stated",
      evidence: [...stated.evidence, ...(level ? [level.evidence] : [])],
    };
  }

  // A named year of study is also stated, but it only yields a graduation year
  // once anchored to the summer the programme runs.
  if (level && programYear) {
    return {
      gradYears: [programYear + level.offset],
      level: level.level,
      basis: "stated",
      evidence: [level.evidence],
    };
  }

  if (level) {
    return { gradYears: [], level: level.level, basis: "stated", evidence: [level.evidence] };
  }

  // Nothing stated, and nothing to pattern-match against here.
  //
  // Returns EMPTY rather than the standard-path guess. `programYear + 1` is
  // usually right, but "usually right" published as a fact is how a student
  // gets told they are ineligible for something they could have applied to.
  // The caller may still fill this in from the same firm's other postings for
  // the same cycle - see inferFromFirmPattern, which is a pattern actually
  // observed at that firm rather than an assumption about firms in general -
  // and where that is not possible the field stays blank.
  return { gradYears: [], level: null, basis: "unknown", evidence: [] };
}


/**
 * Fill a blank eligibility from the same firm's other postings.
 *
 * The educated-guess tier, and it is deliberately narrow. A firm writes its
 * eligibility line once and pastes it across a cycle's postings: PJT states
 * "Anticipated graduation date: Fall 2027 - Spring 2028" on its Summer 2027
 * roles and something different on its January off-cycle ones. So when one
 * posting is silent and its siblings agree, the sibling answer is evidence
 * about THIS firm and THIS cycle, not an assumption about internships.
 *
 * Requires agreement, not a majority. If a firm's postings for one cycle
 * disagree about who may apply, that disagreement is real - the programmes
 * differ - and guessing between them would be inventing the answer this
 * function exists to avoid. Disagreement returns null and the field stays
 * blank.
 */
export function inferFromFirmPattern(
  siblings: { gradYears: number[]; cycleYear: number | null }[],
  cycleYear: number | null,
): Eligibility | null {
  if (cycleYear == null) return null;

  const sameCycle = siblings.filter(
    (s) => s.cycleYear === cycleYear && s.gradYears.length > 0,
  );
  if (sameCycle.length === 0) return null;

  const signatures = new Set(sameCycle.map((s) => [...s.gradYears].sort().join(",")));
  if (signatures.size !== 1) return null;

  const gradYears = [...sameCycle[0].gradYears].sort();
  return {
    gradYears,
    level: null,
    basis: "inferred",
    evidence: [
      `every other ${cycleYear} posting from this firm that states one says graduating ${gradYears.join(", ")} (${sameCycle.length} postings)`,
    ],
  };
}
