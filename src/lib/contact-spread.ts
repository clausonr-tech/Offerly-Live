/**
 * Choosing the handful of contacts the Networking hub leads with.
 *
 * Its own module, and deliberately generic over the row shape, so it can be
 * tested without dragging in the database client or a client component's
 * types - both of which the page that calls it needs and a unit test does not.
 */

/** How many contacts the hub shows before "See all". */
export const PREVIEW_SIZE = 5;

type Spreadable = {
  firm: string | null;
  match: { score: number };
};

/**
 * One person per firm before any firm gets a second.
 *
 * Taking the top five by score alone would routinely return five people from
 * whichever firm the student last generated contacts at, which answers "who
 * is my best match" and not the question the panel is actually asking, which
 * is "where do I stand across the firms I'm working". So: round-robin over
 * firms, best match first within each, and firms ordered by their own best
 * contact so a student with more firms than slots sees their strongest ones.
 *
 * A student with fewer firms than slots does get a second person from a firm -
 * that is the right answer, and it is why the panel's caption says "spread
 * across your firms" rather than promising one apiece.
 */
export function spreadAcrossFirms<T extends Spreadable>(rows: T[], size = PREVIEW_SIZE): T[] {
  if (size <= 0) return [];

  const byFirm = new Map<string, T[]>();
  for (const row of rows) {
    // Contacts with no firm are one bucket, not one bucket each - otherwise a
    // student whose rows are mostly unattached would fill the whole preview
    // with them, each "firm" contributing its single person.
    const firm = row.firm?.trim() || "—";
    byFirm.set(firm, [...(byFirm.get(firm) ?? []), row]);
  }

  const queues = [...byFirm.values()]
    .map((list) => [...list].sort((a, b) => b.match.score - a.match.score))
    .sort((a, b) => b[0].match.score - a[0].match.score);

  const out: T[] = [];
  for (let round = 0; out.length < size; round++) {
    // Nothing left in any queue: the student has fewer contacts than `size`.
    if (!queues.some((queue) => queue.length > round)) break;
    for (const queue of queues) {
      if (out.length >= size) break;
      const row = queue[round];
      if (row) out.push(row);
    }
  }
  return out;
}
