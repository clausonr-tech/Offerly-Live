// Whether a calendar entry is an interview, read from the words in it.
//
// Its own module, with no imports, so the interview prompts (server-only) and
// the thank-you rules and tests can all ask the same question.

/**
 * Words that mean "this is an interview", as they appear in real calendar
 * entries - which are typed in a hurry, abbreviated, and named after the stage
 * of the process rather than the word "interview".
 *
 * Still narrow on purpose. This runs without asking the student first, so a
 * false positive costs them a prompt about something that is not happening.
 * "Chat", "call" and "meeting" are absent - they are most of everyone's
 * calendar - and every short form below is one that means nothing else in a
 * student's week. Grouped by how people write it:
 */
const INTERVIEW_PATTERNS: RegExp[] = [
  // The word itself, plural, and the verb when it says with whom. A bare
  // "interviewing" is a skill or a reading, not an appointment.
  /\binterviews?\b/i,
  /\binterviewing (?:with|at|for)\b/i,
  // Shorthand typed into a calendar on a phone.
  /\b(?:intvw|intrvw|intvws|intv)\b/i,
  // The named events of banking recruiting.
  /\bsuper[- ]?days?\b/i,
  /\bassessment (?:cent(?:re|er)|day)s?\b/i,
  /\bhire[- ]?vue\b/i,
  /\bone[- ]way video\b/i,
  // Named by stage: "first round", "2nd rd", "final stage", "round 2", "R2".
  /\b(?:first|second|third|final|last|1st|2nd|3rd)[- ](?:round|rd|stage)s?\b/i,
  /\b(?:round|rd) ?(?:1|2|3|one|two|three)\b/i,
  /\bR[1-3]\b/,
  // Screens, when they say what kind - "screen" alone is a monitor.
  /\b(?:phone|video|technical|tech|hr|recruiter|initial|first) screen(?:ing)?s?\b(?! (?:repair|protector|replacement|time))/i,
  /\bscreening (?:call|interview)s?\b/i,
  /\bfit call\b/i,
  // Tests that ARE the interview in finance: cases, models, paper LBOs.
  /\bcase study\b/i,
  /\bcase interview\b/i,
  /\bpaper lbo\b/i,
  /\blbo test\b/i,
  /\bmodell?ing (?:test|exam|assessment)s?\b/i,
  /\b(?:technical|online|numerical|written) (?:test|assessment|exam)s?\b/i,
  // Where it happens, when that is the headline.
  /\bon[- ]?site\b/i,
];

/**
 * ...and words that mean it is preparation FOR an interview, not one.
 *
 * "Mock interview 3pm" and "interview prep with Dan" both match the list above
 * and neither is an interview. Prompting someone to practise for their practice
 * is the kind of thing that teaches people to ignore prompts.
 *
 * Two strengths. The strong words rule an entry out wherever they appear -
 * "this is a practice run" in the notes is decisive. The softer ones only in
 * the TITLE: a real superday invitation says "please prepare to walk through
 * your resume" in its notes, and that is an interview, not prep for one.
 */
const NOT_AN_INTERVIEW =
  /\b(?:prep|practice|practise|practicing|practising|mock|coaching|workshop|debrief|feedback|dry run)\b/i;
const NOT_AN_INTERVIEW_IN_TITLE =
  /\b(?:prepping|preparation|prepare|rehearsal|rehearse|webinar|tips|recap|informational|career fair|info(?:rmation)? session)\b/i;

/**
 * A course code: "FIN 3200", "ACCT 201", "CS50" - not a year ("Class of
 * 2019") and not a recruiting cohort ("SA26", "WG25"). An entry that names a
 * course is coursework: "ACCT 201 case study", "STAT 110 online exam".
 * Capitals only, as registrars write them.
 */
export const COURSE_CODE = /\b(?!(?:SA|FT|WG|MBA|IB|PE|AM)\s?\d{2}\b)[A-Z]{2,5} ?(?!(?:19|20)\d{2}\b)\d{2,4}[A-Z]?\b/;

/**
 * Words that say an entry is a conversation outright, and beat interview
 * wording: a coffee chat is a coffee chat even when it is about the interview
 * process. Not "call with a recruiter" - that is how a screening call is
 * written. Shared by the interview prompts and the thank-you prompt, so the
 * two never disagree about what an entry is.
 */
export const CONVERSATION_OVER_INTERVIEW =
  /\b(?:coffee(?: ?chats?| meeting| call)?|virtual coffee|informational(?: chat| call| meeting| interview| session)?|networking (?:call|chat|coffee|lunch|convo))\b/i;

/**
 * Whether a calendar entry names itself an interview.
 *
 * Title first, notes second: the title is what people write the important word
 * in, and notes are where a forwarded invitation chain can mention "interview"
 * about something else entirely. Both are checked, but a title that rules it
 * out rules it out.
 */
export function looksLikeInterview(title: string, notes?: string | null): boolean {
  const haystacks = [title, notes ?? ""].filter(Boolean);
  if (haystacks.some((h) => NOT_AN_INTERVIEW.test(h))) return false;
  if (NOT_AN_INTERVIEW_IN_TITLE.test(title)) return false;
  if (COURSE_CODE.test(title)) return false;
  return haystacks.some((h) => INTERVIEW_PATTERNS.some((p) => p.test(h)));
}

/**
 * The words that made an entry an interview - "superday", "first round" - or
 * null when it is not one. Stored when the detector re-files an entry, so a
 * wrong guess can be traced to what caused it.
 */
export function interviewEvidence(title: string, notes?: string | null): string | null {
  if (!looksLikeInterview(title, notes)) return null;
  for (const h of [title, notes ?? ""]) {
    for (const p of INTERVIEW_PATTERNS) {
      const m = p.exec(h);
      if (m) return m[0];
    }
  }
  return null;
}
