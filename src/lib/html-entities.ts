// Pure, isomorphic HTML-entity decoding.
//
// Lifted out of monitoring/entities.ts (which stays server-only for the
// crawler) because the posting formatter runs inside a client component and
// needs the same decoding. One table, one implementation - a second copy
// would drift, and this one already had a bug worth not duplicating.

/**
 * HTML entities, decoded once for every connector.
 *
 * There were four private copies of this - talentlink, bamboohr, jobvite and
 * finance-news - and none of them exported, so the connectors that never
 * happened to need one simply did not decode. The generic connector is the
 * one that matters now: it is 97.3% of all sources, and it reads titles
 * straight out of scraped HTML.
 *
 * Measured on Supabase, 20 September 2026: BlackRock's "Quantitative
 * Master&rsquo;s Internship Program" reached the published postings table
 * exactly like that, and 14 stored listings carry an undecoded entity in
 * their title. A student sees the raw markup.
 *
 * Applied at the point every connector's output funnels through rather than
 * inside each one, so a connector written next week gets it without having to
 * remember.
 *
 * NUMERIC ENTITIES TOO. `&rsquo;` is the common case in job titles - a
 * curly apostrophe in "Master's" - but boards emit `&#8217;` and `&#x2019;`
 * for the same character, and a decoder that handled only the named form
 * would leave two thirds of them untouched.
 */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  reg: "®",
  trade: "™",
  copy: "©",
  deg: "°",
};

export function decodeEntities(text: string): string {
  if (!text || !text.includes("&")) return text;
  return (
    text
      // Numeric: &#8217; and &#x2019;
      .replace(/&#(\d{1,7});/g, (_, d: string) => safeCodePoint(Number(d)))
      .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
      // Named, including the ones the four private copies each missed.
      .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED[name.toLowerCase()] ?? whole)
      // `&amp;lt;` is a double-encoded "<". One more pass catches it without
      // looping forever on text that legitimately contains an ampersand.
      .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED[name.toLowerCase()] ?? whole)
      // ...and the numeric forms need the same second pass, for the same
      // reason. `&amp;#160;` decodes to the literal text "&#160;" on the named
      // pass above, which ran AFTER the numeric ones - so it survived into the
      // stored posting and was rendered to students as "&#160;". The named
      // form got a second pass and the numeric form did not; now both do.
      .replace(/&#(\d{1,7});/g, (_, d: string) => safeCodePoint(Number(d)))
      .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
  );
}

/**
 * A code point that is not a real character is left as it was found.
 *
 * Surrogates and out-of-range values throw in `String.fromCodePoint`, and a
 * job title is not worth failing a crawl over.
 */
function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
  if (code >= 0xd800 && code <= 0xdfff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}
