// Which summer a student is recruiting for.
//
// This one number decides whether a posting is relevant at all. Finance runs a
// single dominant cycle roughly 18 months ahead, so a student graduating in
// 2029 is competing for Summer 2028 internships - and Summer 2027 postings,
// which are the ones currently filling every board, are not merely a worse
// match for them but closed. Showing those is not a ranking problem, it is
// showing someone a train that left.

/** Parses "Summer 2028" (the onboarding option) into 2028. */
export function parseInternshipYearAnswer(answer: string | null | undefined): number | null {
  if (!answer) return null;
  const m = /\b(20\d{2})\b/.exec(answer);
  return m ? Number(m[1]) : null;
}

type YearInput = {
  targetInternshipYear?: number | null;
  gradYear?: number | null;
};

/**
 * The summer to filter postings by, or null when we genuinely cannot tell.
 *
 * Order matters. The student's own answer always wins; `gradYear - 1` is only
 * a fallback, because it encodes the standard path (intern the summer before
 * final year) and quietly misfiles everyone who is not on it.
 *
 * Returning null means "we don't know", and callers must treat that as "do not
 * filter by year" rather than "show nothing" - an unanswered question should
 * cost a student precision, never the entire product.
 */
export function internshipYearFor(user: YearInput): number | null {
  if (user.targetInternshipYear != null) return user.targetInternshipYear;
  if (user.gradYear != null) return targetProgramYear(user.gradYear);
  return null;
}

/**
 * The standard path: intern the summer before final year.
 *
 * Lives here rather than beside the posting queries so there is exactly one
 * definition of the offset - it was already written in two places, and two
 * copies of a rule like this drift the moment one caller learns about MBA
 * cycles and the other doesn't.
 */
export function targetProgramYear(gradYear: number): number {
  return gradYear - 1;
}
