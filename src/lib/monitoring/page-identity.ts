import "server-only";

/**
 * Did this posting's title survive the round trip to the page?
 *
 * Two distinctive words, not the whole string: boards reformat titles - case,
 * dashes, an appended location, "(m/w/d)", a requisition number. Words shorter
 * than five characters and the generic ones every posting carries are no
 * evidence, so they do not count toward the two.
 */
export function titleAppearsIn(title: string, text: string): boolean {
  const haystack = text.toLowerCase();
  const generic = new Set([
    "intern", "internship", "summer", "analyst", "associate", "program", "programme",
    "graduate", "student", "trainee", "placement", "group", "team", "senior", "junior",
  ]);
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f]+/)
    .filter((w) => w.length >= 5 && !generic.has(w));
  if (words.length === 0) {
    // Nothing distinctive to look for - do not block on it.
    return true;
  }
  const hits = words.filter((w) => haystack.includes(w)).length;
  return hits >= Math.min(2, words.length);
}
