/** One sector's specialties, labelled with the sector's display name. */
export type NicheGroup = { group: string; sectors: string[] };

/**
 * The specialties to offer a student who picked these sectors, deduped.
 *
 * A student recruiting for both banking and private equity is offered both
 * sets, not whichever sector they happened to click last. Order follows
 * `groups` so the list does not reshuffle as chips are ticked, and a
 * specialty two sectors share (Commodities Trading is both a hedge fund
 * strategy and a trading desk) appears once.
 *
 * Client-safe on purpose - no firm directory, no question bank - because the
 * profile's Interests editor runs it in the browser.
 */
export function nicheOptionsFor(groups: readonly NicheGroup[], sectorLabelsPicked: readonly string[]): string[] {
  return Array.from(new Set(groups.filter((g) => sectorLabelsPicked.includes(g.group)).flatMap((g) => g.sectors)));
}
