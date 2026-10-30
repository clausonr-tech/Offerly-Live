/**
 * Which recruiting cycles a student may report against.
 *
 * Its own module rather than living beside the action that uses it: a
 * "use server" file may only export async server actions, so a plain helper
 * exported from actions.ts is a build error the moment a page imports it.
 */

/**
 * The cycle a report defaults to.
 *
 * Banking recruits roughly two years ahead - in autumn 2026 the live
 * applications are for Summer 2028 - so this follows that rather than the
 * "next calendar year" convention used for already-published programmes. It is
 * only a default: the form offers the neighbouring cycles too, because a
 * student looking at an off-cycle or a European summer programme knows which
 * one they are looking at better than this function does.
 */
export function defaultCycleYear(now = new Date()): number {
  return now.getMonth() >= 3 ? now.getFullYear() + 2 : now.getFullYear() + 1;
}

/** The default and one cycle either side. Bounded deliberately: a free-text
 *  year invites 1987 and 20288, and every value outside this range is a typo
 *  rather than a report. */
export function selectableCycleYears(now = new Date()): number[] {
  const base = defaultCycleYear(now);
  return [base - 1, base, base + 1];
}
