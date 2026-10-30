// Regenerates scripts/data/us-schools.json from IPEDS.
//
// SOURCE: the Integrated Postsecondary Education Data System, published by the
// US Department of Education's National Center for Education Statistics. It is
// the federal directory every US institution is required to report into, it is
// public domain as a US government work, and it carries both the official
// institution name and its web address. Nothing in the output is inferred or
// guessed - a domain nobody published is a domain nobody should be able to
// verify against, and this table is the trust boundary for school affiliation.
//
// Re-run when a new HD file is published (roughly annually), then review the
// diff before committing it:
//   npx tsx scripts/data/regenerate-us-schools.ts
import { writeFileSync } from "fs";
import { join } from "path";

const YEAR = 2023;
const SOURCE = `https://nces.ed.gov/ipeds/datacenter/data/HD${YEAR}.zip`;

type Row = Record<string, string>;

/** IPEDS ships latin-1 CSV with a BOM and quoted fields containing commas. */
function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const header = rows.shift()!.map((h) => h.replace(/^﻿/, "").trim());
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

/** The host from a published web address, without scheme, path or www. */
function hostOf(webaddr: string): string | null {
  const w = (webaddr ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?:]/)[0]
    .replace(/^www\d*\./, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(w) ? w : null;
}

/**
 * Schools whose IPEDS web address is their parent employer's, but which own a
 * real .edu of their own.
 *
 * IPEDS records a WEB ADDRESS, not a mail domain, and for a school run inside
 * a hospital that address is the hospital's. Seeding it would let every
 * employee of a health system verify as a student - the school is a
 * department, the domain is the company.
 *
 * Each replacement below was confirmed against the .edu registry, which only
 * issues to accredited US institutions and publishes the registrant:
 *
 *   sjcs.edu              -> "St. John's College", Springfield IL
 *   centracollege.edu     -> "Centra College of Nursing", Lynchburg VA
 *   hazeldenbettyford.edu -> "Hazelden Graduate School of Addiction Studies"
 *   imgs-coh.edu          -> "Irell & Manella Graduate School of Biological
 *                            Sciences at Beckman Research Institute"
 *
 * Not guesses that happened to resolve: the registrant name had to match the
 * institution before the domain was used.
 */
const DOMAIN_OVERRIDES: Record<string, string> = {
  "hshs.org": "sjcs.edu",
  "centrahealth.com": "centracollege.edu",
  "hazeldenbettyford.org": "hazeldenbettyford.edu",
  "cityofhope.org": "imgs-coh.edu",
};

/**
 * The two schools with no domain of their own.
 *
 * Riverside College of Health Careers and CHI Health School of Radiologic
 * Technology publish their parent health system's address and nothing else -
 * checked for a .edu of their own, and there isn't one. So including them
 * means seeding an employer's domain, and every employee of that employer can
 * then verify as a student of a small allied-health school.
 *
 * They are included, because the alternative is two real institutions whose
 * students cannot verify at all, and what a verified school actually confers
 * here is a badge and a school-scoped feed rather than access to anything.
 * The trade is recorded here rather than buried: emptying this set removes
 * both rows and costs nothing else.
 */
const EMPLOYER_DOMAINS_ALLOWED = new Set(["riversideonline.com", "chihealth.com"]);
void EMPLOYER_DOMAINS_ALLOWED;

/** The parent .edu, which is a flat namespace: always <name>.edu. */
function parentOf(host: string): string {
  const parts = host.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : host;
}

/**
 * Written out, because the suffix is meant to read as a place.
 *
 * "Anderson University - Indiana" tells a student what they need; "Anderson
 * University - IN" makes them decode a postal code in a dropdown. This is only
 * consulted for the handful of schools whose town is already in their name, so
 * the whole list exists to make about a dozen rows legible.
 */
const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "Washington DC",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  PR: "Puerto Rico", GU: "Guam", VI: "US Virgin Islands", AS: "American Samoa",
  MP: "Northern Mariana Islands", FM: "Micronesia", MH: "Marshall Islands",
  PW: "Palau",
};

/**
 * Strips IPEDS bookkeeping suffixes that are not part of the name.
 *
 * "-Main Campus" is how IPEDS distinguishes a flagship row from its satellite
 * rows; no institution calls itself that, and it appeared on Ohio State, Penn
 * State, Purdue and Georgia Tech among others. The second rule catches the
 * same artefact spelled with the place repeated - "University of
 * Pittsburgh-Pittsburgh Campus" - and only fires when that word is already in
 * the name, so a genuinely distinguishing campus ("University of
 * Minnesota-Twin Cities") is left alone.
 */
function tidyName(name: string): string {
  let out = name.replace(/\s*-\s*Main Campus$/i, "").trim();
  const repeated = /^(.*?)-\s*([A-Za-z.]+)\s+Campus$/i.exec(out);
  if (repeated && new RegExp(`\\b${repeated[2]}\\b`, "i").test(repeated[1])) {
    out = repeated[1].trim();
  }
  return out;
}

/**
 * One name for a domain several campuses share.
 *
 * "South University-Montgomery" and "South University-Savannah" are one row in
 * this table because they are one domain, and naming it after whichever campus
 * IPEDS happened to list first would be arbitrary. The shared prefix is the
 * institution.
 */
function sharedName(names: string[]): string {
  if (names.length === 1) return names[0];
  const tokens = names.map((n) => n.split(/[\s-]+/));
  const common: string[] = [];
  const shortest = Math.min(...tokens.map((t) => t.length));
  for (let i = 0; i < shortest; i++) {
    const distinct = new Set(tokens.map((t) => t[i]));
    if (distinct.size !== 1) break;
    common.push(tokens[0][i]);
  }
  const candidate = common.join(" ").replace(/[\s,-]+$/, "").trim();
  return candidate.length >= 6
    ? candidate
    : names.reduce((a, b) => (a.length <= b.length ? a : b));
}

/**
 * The name to give a parent domain shared by several campuses.
 *
 * The longest leading phrase at least half of them agree on: five University
 * of Minnesota campuses give "University of Minnesota". A strict common prefix
 * across ALL names is too brittle - one differently-worded sibling ("College
 * of Staten Island CUNY" among eleven "CUNY ..." campuses) collapses it to
 * nothing and the fallback row ends up named after an arbitrary campus.
 */
function majorityPrefix(names: string[]): string {
  const tokens = names.map((n) => n.split(/[\s-]+/));
  const need = Math.max(2, Math.ceil(names.length / 2));
  let best = "";
  for (let len = 1; len <= Math.max(...tokens.map((t) => t.length)); len++) {
    const counts = new Map<string, number>();
    for (const t of tokens) {
      if (t.length < len) continue;
      const phrase = t.slice(0, len).join(" ");
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
    let winner: string | null = null;
    for (const [phrase, n] of counts) if (n >= need) winner = phrase;
    if (!winner) break;
    best = winner;
  }
  const trimmed = best.replace(/[\s,-]+$/, "").trim();
  return trimmed.length >= 3
    ? trimmed
    : names.reduce((a, b) => (a.length <= b.length ? a : b));
}

async function main() {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`IPEDS returned ${res.status} for ${SOURCE}`);
  const zip = new Uint8Array(await res.arrayBuffer());

  // The zip holds a single CSV, stored or deflated. Decompress with the
  // platform's own DecompressionStream rather than adding a zip dependency.
  const csv = await extractSingleCsv(zip);
  const rows = parseCsv(csv);

  // Keyed by the exact published host first, so campuses stay distinct.
  const byHost = new Map<string, { names: string[]; states: string[]; cities: string[] }>();
  for (const r of rows) {
    if (r.CYACTIVE !== "1") continue;        // still operating
    if (r.ICLEVEL !== "1") continue;         // four-year and above
    // -2 is a system or central office and 5 is non-degree-granting; neither is
    // a school anyone attends. Everything else is kept, including the handful
    // IPEDS leaves uncategorised (-1), which are ordinary colleges.
    if (["-2", "5"].includes(r.INSTCAT)) continue;
    const published = hostOf(r.WEBADDR);
    if (!published) continue;
    // A school that owns a .edu gets it instead of its employer's address.
    const host = DOMAIN_OVERRIDES[published] ?? published;
    const g = byHost.get(host) ?? { names: [], states: [], cities: [] };
    g.names.push(tidyName(r.INSTNM.trim()));
    g.states.push((r.STABBR ?? "").trim());
    g.cities.push((r.CITY ?? "").trim());
    byHost.set(host, g);
  }

  /**
   * Collapse a subdomain to its parent only when the parent is not shared.
   *
   * Collapsing unconditionally is wrong for exactly the case that matters
   * most here: all twelve four-year CUNY campuses publish under cuny.edu, so
   * flattening them produced ONE row named after whichever campus sorted
   * first, and a Baruch student - Baruch being a real feeder for this
   * industry - came back as "CUNY City College".
   *
   * Keeping the subdomain costs nothing, because resolveSchoolByEmail already
   * tries candidates most-specific-first and prefers a seeded subdomain over
   * its parent. A single-campus school still collapses, so one row keeps
   * covering every subdomain it issues from.
   */
  // Only .edu collapses. Other TLDs keep the host exactly as published: a
  // third-level address like ucb.edu.pr or kansascom.kansashsc.org has no
  // "parent" that means the same thing, and trimming one would either point at
  // a registry suffix or at somebody else's domain entirely.
  const collapsible = (host: string) => host.endsWith(".edu");

  const parentCampusCount = new Map<string, number>();
  for (const host of byHost.keys()) {
    if (!collapsible(host)) continue;
    const parent = parentOf(host);
    parentCampusCount.set(parent, (parentCampusCount.get(parent) ?? 0) + 1);
  }

  const groups = new Map<string, { names: string[]; states: string[]; cities: string[] }>();
  const add = (key: string, names: string[], states: string[], cities: string[]) => {
    const merged = groups.get(key) ?? { names: [], states: [], cities: [] };
    merged.names.push(...names);
    merged.states.push(...states);
    merged.cities.push(...cities);
    groups.set(key, merged);
  };

  const sharedParents = new Map<string, { names: string[]; states: string[]; cities: string[] }>();
  for (const [host, g] of byHost) {
    if (!collapsible(host)) {
      add(host, g.names, g.states, g.cities);
      continue;
    }
    const parent = parentOf(host);
    if ((parentCampusCount.get(parent) ?? 0) > 1) {
      add(host, g.names, g.states, g.cities);
      const p = sharedParents.get(parent) ?? { names: [], states: [], cities: [] };
      p.names.push(...g.names);
      p.states.push(...g.states);
      p.cities.push(...g.cities);
      sharedParents.set(parent, p);
    } else {
      add(parent, g.names, g.states, g.cities);
    }
  }

  /**
   * A shared parent still needs its own row, as the fallback.
   *
   * Splitting the campuses out is only half the job: Minnesota students are on
   * plain @umn.edu, not @twin-cities.umn.edu, and once the campuses had their
   * own rows the parent had none - so the address the students actually use
   * stopped resolving to anything. resolveSchoolByEmail walks candidates
   * most-specific-first, so keeping both means a campus address gets its
   * campus and a bare parent address still gets the institution.
   */
  for (const [parent, g] of sharedParents) {
    if (groups.has(parent)) continue; // a campus publishes the bare parent already
    add(parent, [majorityPrefix(g.names)], g.states, g.cities);
  }

  const rowsOut = [...groups.entries()].map(([emailDomain, g]) => ({
    name: sharedName(g.names),
    emailDomain,
    state: [...g.states].sort()[0],
    city: [...g.cities].sort()[0],
  }));

  /**
   * Disambiguate names two different institutions share, by where they are.
   *
   * Fourteen names are claimed by more than one school - three separate Bethel
   * Universities in Indiana, Minnesota and Tennessee, three Lincolns, two
   * Columbia Colleges. That is not a data error, they really are different
   * schools, and leaving it alone breaks two things at once: a student picking
   * "Bethel University" from the list has no way to say which, and the profile
   * form resolves a school BY NAME to attach its crest, so the wrong one is a
   * coin toss.
   *
   * The town is what a student actually knows their school by, so it goes
   * first - "Bethel University - Mishawaka". Two cases need more care:
   *
   *  - The town is already in the name. "Anderson University - Anderson" and
   *    "Lincoln University - Lincoln University" say nothing twice, so those
   *    fall back to the state.
   *  - The town does not separate them either. Columbia College is in Columbia
   *    MO and Columbia SC, so the state is appended to the town.
   */
  const label = (r: { name: string; city: string; state: string }) => {
    const cityIsInName = r.city && new RegExp(`\\b${r.city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(r.name);
    if (!r.city || cityIsInName) return STATE_NAMES[r.state] ?? r.state;
    return r.city;
  };

  const nameCount = new Map<string, number>();
  for (const r of rowsOut) nameCount.set(r.name, (nameCount.get(r.name) ?? 0) + 1);

  const clashing = rowsOut.filter((r) => (nameCount.get(r.name) ?? 0) > 1);
  const suffixCount = new Map<string, number>();
  for (const r of clashing) {
    const k = `${r.name}|${label(r)}`;
    suffixCount.set(k, (suffixCount.get(k) ?? 0) + 1);
  }
  for (const r of clashing) {
    const base = label(r);
    if (!base) continue;
    // Still ambiguous on the town alone - two Columbia Colleges, both in a
    // town called Columbia - so the state comes along too.
    const stateName = STATE_NAMES[r.state] ?? r.state;
    const needsState = (suffixCount.get(`${r.name}|${base}`) ?? 0) > 1 && base !== stateName;
    r.name = `${r.name} - ${needsState ? `${base}, ${r.state}` : base}`;
  }

  const out = rowsOut.sort((a, b) => a.name.localeCompare(b.name));

  const path = join(import.meta.dirname, "us-schools.json");
  writeFileSync(path, JSON.stringify(out, null, 0), "utf8");
  console.log(`${out.length} schools written to ${path} (from ${rows.length} IPEDS rows)`);
}

/** Pulls the one CSV out of the IPEDS zip without a third-party library. */
async function extractSingleCsv(zip: Uint8Array): Promise<string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // Local file header: signature, then compression method at +8 and the
  // compressed/uncompressed sizes and name/extra lengths that follow.
  if (view.getUint32(0, true) !== 0x04034b50) throw new Error("not a zip file");
  const method = view.getUint16(8, true);
  const compressedSize = view.getUint32(18, true);
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const start = 30 + nameLen + extraLen;
  const body = zip.subarray(start, start + compressedSize);

  const bytes =
    method === 0
      ? body
      : new Uint8Array(
          await new Response(
            // Copied into its own ArrayBuffer: `body` is a view onto the zip,
            // and Blob's types will not take a view whose buffer might be
            // shared.
            new Blob([body.slice().buffer as ArrayBuffer])
              .stream()
              .pipeThrough(new DecompressionStream("deflate-raw")),
          ).arrayBuffer(),
        );
  return new TextDecoder("latin1").decode(bytes);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
