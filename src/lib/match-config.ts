// How big a match is.
//
// Its own module because both halves of the matcher need it and they call each
// other: discovery-matches decides whether to top a student's list up, and
// match-top-firms needs to know what it is topping up to. Holding the number in
// either one makes the pair circular.

/**
 * Firms a completed match holds. Discovery lists all of them.
 *
 * A ceiling, not a quota. The matcher stops early when the student's stated
 * constraints genuinely leave fewer firms that satisfy them - a student who
 * says "bulge bracket investment banking" should get the handful of banks that
 * are actually bulge bracket, not those plus forty-odd near-misses padded in
 * to hit a number.
 */
export const MATCHED_FIRMS = 50;

/**
 * What Opportunities shows. It is the page a student opens to work, not to
 * browse: twelve firms is a session's worth of outreach, and the rest are one
 * click away in Discovery rather than buried at the bottom of a grid nobody
 * scrolls to.
 */
export const OPPORTUNITY_FIRMS = 12;

/** People surfaced per firm. */
export const CONTACTS_PER_FIRM = 5;
