// Write eligibility that was read out of postings by hand, not by the model.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/apply-eligibility-read.ts [--apply]
//
// WHY THIS EXISTS ALONGSIDE backfill-eligibility.ts
// -------------------------------------------------
// That script does the same job with a Haiku call per posting. This one does
// it for the postings somebody has already read, and costs nothing. The write
// is deliberately identical - same `eligibility` shape, same `basis: "stated"`,
// same update to the published row - so a posting filled in here is
// indistinguishable downstream from one the model filled in. Neither is a
// guess: both quote the firm.
//
// THE SAFETY PROPERTY IS THE SAME, AND IT IS NOT OPTIONAL
// ------------------------------------------------------
// llm-extract.ts accepts an answer only if its quote is found in the source
// text, because a quote that cannot be located is indistinguishable from an
// invention. A human reading postings is no more trustworthy than a model on
// this specific point - the failure is transcription, not reasoning, and
// typing a year into the wrong row looks exactly like a correct one
// afterwards.
//
// So the decisions below carry an ANCHOR, not a quote: a pattern the posting
// must match. The script finds it, takes a window around it, checks the window
// still contains what matched, and stores that. An anchor that matches nothing
// is refused and reported. The evidence in the database is therefore always
// text the firm wrote, never text this file contains.
import { createHash } from "crypto";
import { getDb } from "../src/db/client";
import { detectedListings, internshipPostings, firmMonitoringSources, firms } from "../src/db/schema";
import { and, eq, inArray } from "drizzle-orm";
// Every write below is limited to origin = "crawler": a posting a firm wrote
// itself on the firm portal is the firm's, and no script may change it.
import { assertExclusiveDbAccess } from "../src/lib/monitoring/exclusive-db";
import { findBlockedLanguage } from "../src/lib/content-limits";
import type { Classification } from "../src/lib/monitoring/classify";

const apply = process.argv.includes("--apply");

type Decision = {
  /** First 12 chars of sha256(descriptionRaw) - see eligibility-candidates.ts. */
  hash: string;
  gradYears: number[];
  /** Must match the posting's own text. Whitespace-tolerant on purpose: several
   *  of these boards emit "202 7" and "20 28" with stray spaces inside the
   *  number, which is the firm's rendering and not ours to normalise away. */
  anchor: RegExp;
  /** Study-year wording, where the posting gives one. */
  level?: string;
  /** Why these years, when the posting states a position rather than a date. */
  note?: string;
};

/**
 * Read 19 September 2026 from the output of eligibility-candidates.ts.
 *
 * 129 distinct descriptions had blank eligibility. 66 contain no
 * eligibility-shaped sentence at all, and the rest mostly state a DEGREE
 * ("Pursuing a BA/BS"), a DISCIPLINE, or work authorisation - none of which is
 * a graduation date. That is the same finding the model pass reported, and it
 * is a correct blank rather than a miss: `getRelevantPostings` treats an empty
 * list as "the posting did not say", which restricts nobody.
 *
 * These are the ones that do say.
 */
const DECISIONS: Decision[] = [
  // ---- Ankura: states the window outright, in five slightly different
  // renderings. Note the stray spaces inside the numerals - their board
  // emits "202 7" and "20 28" - which is why these are anchors and not
  // string equality.
  {
    hash: "fea3eed45f3e",
    gradYears: [2027, 2028],
    anchor: /graduation\s+between\s+December\s*2\s*0\s*2\s*7\s+and\s+June\s*2\s*0\s*2\s*8/i,
  },
  {
    hash: "d16eb32d2b0b",
    gradYears: [2027, 2028],
    anchor: /graduation\s+between\s+December\s*2\s*0\s*2\s*7\s+and\s+June\s*2\s*0\s*2\s*8/i,
  },
  {
    hash: "a033e792860e",
    gradYears: [2027, 2028],
    anchor: /graduation\s+between\s+December\s*2\s*0\s*2\s*7\s+and\s+June\s*2\s*0\s*2\s*8/i,
  },
  {
    hash: "bae77428a312",
    gradYears: [2027, 2028],
    anchor: /Graduating\s+between\s+December\s*2\s*0\s*2\s*7\s+and\s+June\s*2\s*0\s*2\s*8/i,
  },
  {
    hash: "7f38b9bf2e14",
    gradYears: [2027, 2028],
    anchor: /graduation\s+between\s+December\s*2\s*0\s*2\s*7\s+and\s+June\s*2\s*0\s*2\s*8/i,
  },

  // ---- Piper Sandler: names both calendar points explicitly. December 2027
  // and Spring 2028 are two graduation dates, so both years are listed.
  {
    hash: "a208e35dfb21",
    gradYears: [2027, 2028],
    anchor: /open\s+to\s+undergraduate\s+students\s+who\s+graduate\s+in\s+December\s+2027\s+or\s+Spring\s+2028/i,
    level: "undergraduate",
  },
  {
    hash: "dbec6c5597f2",
    gradYears: [2027, 2028],
    anchor: /open\s+to\s+undergraduate\s+students\s+who\s+graduate\s+in\s+December\s+2027\s+or\s+Spring\s+2028/i,
    level: "undergraduate",
  },

  // ---- Barclays: states a POSITION in a degree, not a date, so the years are
  // derived from it plus the programme's own 2027 cycle - final year at the
  // time of a 2027 internship graduates 2027, penultimate graduates 2028.
  //
  // Included because this is the shape the model pass was verified against: a
  // posting saying "two years away from completing their undergraduate degree"
  // was read as 2029 for a Summer 2027 internship. The arithmetic is the same
  // and the quote records what was actually said, so a reviewer can disagree
  // with the derivation without having to re-find the sentence.
  {
    hash: "18e164dddfbb",
    gradYears: [2027, 2028],
    anchor: /you\s+must\s+be\s+in\s+your\s+penultimate\s+or\s+final\s+year\s+of\s+your\s+degree/i,
    level: "penultimate or final year",
    note: "derived from the stated year of study plus the programme's 2027 cycle",
  },
];

/**
 * The matched text plus enough of its surroundings to read as prose.
 *
 * Centred on the match, deliberately. The obvious version of this walks out to
 * the nearest full stops, and on these postings that is wrong: job
 * descriptions are bullet lists with almost no sentence punctuation, so
 * "nearest full stop" jumped several hundred characters backwards and returned
 * "Responsibilities: Develop and use knowledge of technology..." as the
 * evidence for a graduation window. The stored quote then showed a reviewer
 * nothing about why the years were chosen, which is the one job it has.
 *
 * So the window is bounded around the match first and only tidied inwards, and
 * the caller asserts the result still contains what was matched.
 */
function evidenceAround(text: string, matchIndex: number, matchLength: number): string {
  const PAD = 130;
  const from = Math.max(0, matchIndex - PAD);
  const to = Math.min(text.length, matchIndex + matchLength + PAD);
  let span = text.slice(from, to).replace(/\s+/g, " ").trim();
  // Drop a leading partial word, and a trailing one, so the quote does not
  // start or end mid-token.
  if (from > 0) span = span.replace(/^\S*\s+/, "");
  if (to < text.length) span = span.replace(/\s+\S*$/, "");
  return span;
}

/** Whitespace-insensitive containment. The anchors are whitespace-tolerant
 *  because these boards split numerals, so the check has to be too. */
function looselyContains(haystack: string, needle: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  return flat(haystack).includes(flat(needle));
}

async function main() {
  await assertExclusiveDbAccess();
  const db = await getDb();

  const rows = await db
    .select({
      id: detectedListings.id,
      title: detectedListings.title,
      desc: detectedListings.descriptionRaw,
      cls: detectedListings.classification,
      promoted: detectedListings.promotedPostingId,
      firm: firms.name,
    })
    .from(detectedListings)
    .innerJoin(firmMonitoringSources, eq(firmMonitoringSources.id, detectedListings.sourceId))
    .innerJoin(firms, eq(firms.id, firmMonitoringSources.firmId))
    .where(inArray(detectedListings.reviewStatus, ["auto_approved", "approved", "pending_review"]));

  const byHash = new Map<string, typeof rows>();
  for (const r of rows) {
    const h = createHash("sha256").update(r.desc ?? "").digest("hex").slice(0, 12);
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h)!.push(r);
  }

  let written = 0;
  let refused = 0;
  let unchanged = 0;

  for (const d of DECISIONS) {
    const group = byHash.get(d.hash);
    if (!group?.length) {
      console.log(`REFUSED ${d.hash}: no listing has this description any more`);
      refused++;
      continue;
    }

    for (const r of group) {
      const desc = r.desc ?? "";
      const m = d.anchor.exec(desc);
      if (!m) {
        console.log(`REFUSED ${d.hash} ${r.firm} · ${r.title.slice(0, 44)}: anchor not found in the posting`);
        refused++;
        continue;
      }

      const quote = evidenceAround(desc, m.index, m[0].length);

      // The stored evidence must contain the sentence the years came from. If
      // it does not, the quote proves nothing and the row is refused rather
      // than written with misleading support.
      if (!looselyContains(quote, m[0])) {
        console.log(`REFUSED ${d.hash} ${r.firm}: evidence window lost the matched text`);
        refused++;
        continue;
      }

      // The quote is stored and can be shown to a reviewer, so it goes through
      // the same check as any other text this system surfaces.
      const blocked = findBlockedLanguage(quote);
      if (blocked) {
        console.log(`REFUSED ${d.hash} ${r.firm}: quote contains blocked language (${blocked})`);
        refused++;
        continue;
      }

      const c = r.cls as Classification;
      if (c.eligibility?.gradYears?.length) {
        unchanged++;
        continue;
      }

      console.log(`${apply ? "WRITE" : "OK   "} ${r.firm.padEnd(22)} grad ${d.gradYears.join("/")}  ${r.title.slice(0, 40)}`);
      // Printed in full, not truncated: this line is the audit trail, and a
      // quote cut off before the sentence it is evidence for proves nothing.
      console.log(`         "${quote}"`);
      if (d.note) console.log(`         note: ${d.note}`);

      if (apply) {
        const next: Classification = {
          ...c,
          eligibility: {
            gradYears: d.gradYears,
            level: (d.level as Classification["eligibility"]["level"]) ?? null,
            // "stated" for the same reason backfill-eligibility uses it: the
            // firm said this, and the quote above is where. Finding it was the
            // only work.
            basis: "stated",
            evidence: [quote],
          },
          matchedEvidence: [
            ...c.matchedEvidence,
            `eligibility read from the posting: "${quote.slice(0, 120)}"` + (d.note ? ` (${d.note})` : ""),
          ],
        };

        await db
          .update(detectedListings)
          .set({ classification: next, updatedAt: new Date() })
          .where(eq(detectedListings.id, r.id));

        // Keep the published row in step, or the posting keeps being offered to
        // everyone while the listing behind it knows better.
        if (r.promoted) {
          await db
            .update(internshipPostings)
            .set({ eligibleGradYears: d.gradYears, updatedAt: new Date() })
            .where(and(eq(internshipPostings.id, r.promoted), eq(internshipPostings.origin, "crawler")));
        }
      }
      written++;
    }
  }

  console.log(
    `\n${apply ? written + " written" : written + " would be written"}, ${refused} refused, ${unchanged} already had years.`,
  );
  if (!apply) console.log("Dry run - pass --apply to write.");
  process.exit(0);
}

main();
