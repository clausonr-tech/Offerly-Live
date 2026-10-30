import { decodeEntities } from "../html-entities";
import type { Entity, RawItem, Sector, StoryType } from "./types";

// SEC filings as news, with no model involved. The form already says what the
// story is - an S-1 is an IPO filing, a 13D from an activist is an activist
// stake - so a model would only add cost and a chance to be wrong.
//
// EDGAR's "current filings" Atom feed lists one entry per filer role. A 13D
// appears twice: once under the company whose shares were bought ("(Subject)")
// and once under the buyer ("(Filed by)"). Both share the filing's accession
// number, which is how the two halves are paired.

export const EDGAR_FEED = (form: string) =>
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(form)}&company=&dateb=&owner=include&start=0&count=100&output=atom`;

/** The SEC requires automated clients to name a contact; without one it refuses every request. */
export function edgarUserAgent(): string | null {
  const contact = process.env.NEWS_SEC_CONTACT?.trim();
  return contact ? `Offerly news ${contact}` : null;
}

// Activists whose 13Ds are news in themselves. A 13D from anyone else is
// usually a strategic holder or a family office and not a coffee-chat topic.
const ACTIVISTS = [
  "elliott",
  "starboard",
  "trian",
  "pershing square",
  "valueact",
  "jana partners",
  "icahn",
  "third point",
  "engine capital",
  "ancora",
  "land & buildings",
  "sachem head",
  "corvex",
  "mantle ridge",
  "legion partners",
  "politan",
  "irenic",
  "anson funds",
  "d. e. shaw",
  "cevian",
  "palliser",
  "saba capital",
];

// Registration statements that are not operating-company IPOs.
const NOT_AN_IPO_RE = /\b(acquisition corp|acquisition co|spac|capital trust|\betf\b|fund\b|trust\b|bitcoin|ether)\b/i;

export type EdgarEntry = {
  form: string;
  company: string;
  role: "Filer" | "Subject" | "Filed by" | string;
  accession: string;
  url: string;
  filedAt: Date | null;
};

export function parseEdgarAtom(xml: string): EdgarEntry[] {
  const entries: EdgarEntry[] = [];
  for (const block of xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []) {
    const title = decodeEntities(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").trim();
    // "S-1 - Acme Robotics, Inc. (0001234567) (Filer)"
    const m = title.match(/^(.+?) - (.+) \((\d{10})\) \(([^)]+)\)$/);
    const href = block.match(/<link[^>]*href="([^"]+)"/)?.[1];
    const updated = block.match(/<updated>([^<]+)<\/updated>/)?.[1];
    const accession = block.match(/<id>[^<]*accession-number=([\d-]+)<\/id>/)?.[1] ?? href?.match(/(\d{10}-\d{2}-\d{6})/)?.[1];
    if (!m || !href || !accession) continue;
    const filedAt = updated ? new Date(updated) : null;
    entries.push({
      form: m[1].trim(),
      company: m[2].trim(),
      role: m[4],
      accession,
      url: decodeEntities(href),
      filedAt: filedAt && !isNaN(filedAt.getTime()) ? filedAt : null,
    });
  }
  return entries;
}

// EDGAR names are the legal names in capitals ("ACME ROBOTICS, INC."). Enough
// tidying that a headline reads like one, without pretending to know branding.
export function tidyCompanyName(name: string): string {
  const cased = name === name.toUpperCase() ? name.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()) : name;
  return cased
    .replace(/,?\s+(Inc|Corp|Corporation|Ltd|Limited|LLC|L\.P\.|LP|plc|Co)\.?$/i, "")
    .replace(/\/[A-Z]{2}\/?$/i, "")
    .trim();
}

/**
 * `worthiness` decides whether a filing is a card of its own. A registration
 * statement is not: tested on the live feed on 29 September 2026, most S-1s
 * and F-1s were micro-caps, and several were follow-on or resale
 * registrations by companies already listed (BioLineRx, VCI Global) - the
 * feed cannot tell an IPO from those, so "files to go public" would have been
 * wrong. They are stored at worthiness 1 (never shown alone) with the company
 * named, so a newsroom's "X files for IPO" story groups with the filing and
 * the filing becomes its official confirmation. An activist 13D is news in
 * itself and is shown.
 */
export type EdgarStory = RawItem & { form: string; storyType: StoryType; sectors: Sector[]; worthiness: number; entities: Entity[] };

export function edgarStories(entries: EdgarEntry[]): EdgarStory[] {
  const stories: EdgarStory[] = [];
  const base = { description: null, publisher: "SEC filing", publisherDomain: "sec.gov", imageUrl: null };

  const registered = new Set<string>();
  for (const e of entries) {
    if ((e.form === "S-1" || e.form === "F-1") && e.role === "Filer" && !NOT_AN_IPO_RE.test(e.company)) {
      // A company often files twice in a few minutes (WeShop, 29 September 2026).
      const company = tidyCompanyName(e.company);
      if (registered.has(`${company}|${e.form}`)) continue;
      registered.add(`${company}|${e.form}`);
      stories.push({
        ...base,
        title: `${company} files a registration statement (${e.form})`,
        url: e.url,
        publishedAt: e.filedAt,
        form: e.form,
        storyType: "ecm_ipo",
        sectors: ["investment_banking"],
        worthiness: 1,
        entities: [{ name: company, role: "issuer" }],
      });
    }
  }

  const byAccession = new Map<string, EdgarEntry[]>();
  for (const e of entries) {
    if (!/13D/.test(e.form) || /\/A$/.test(e.form)) continue; // amendments are not new stakes
    byAccession.set(e.accession, [...(byAccession.get(e.accession) ?? []), e]);
  }
  for (const group of byAccession.values()) {
    const filer = group.find((e) => e.role === "Filed by");
    const subject = group.find((e) => e.role === "Subject");
    if (!filer || !subject) continue;
    const who = filer.company.toLowerCase();
    if (!ACTIVISTS.some((a) => who.includes(a))) continue;
    stories.push({
      ...base,
      title: `${tidyCompanyName(filer.company)} discloses an activist stake in ${tidyCompanyName(subject.company)} (13D)`,
      url: subject.url,
      publishedAt: subject.filedAt,
      form: subject.form,
      storyType: "activism",
      sectors: ["hedge_fund"],
      worthiness: 3,
      entities: [
        { name: tidyCompanyName(filer.company), role: "investor" },
        { name: tidyCompanyName(subject.company), role: "target" },
      ],
    });
  }
  return stories;
}
