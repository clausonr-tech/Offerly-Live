// Compare every stored deadline against what the firm's feed says TODAY.
//
// A deadline is the one field in this pipeline a student acts on directly, and
// it is also the one most easily corrupted in transit: it arrives as prose
// ("Application Deadline:15 Nov 2026 11:55 PM EST"), gets parsed to an
// instant, stored in a timestamp column, and rendered in some timezone. Each
// of those four steps has already been wrong once.
//
// This re-reads the source and diffs, so drift is caught by evidence rather
// than by a student noticing. Currently covers TalentLink, which is where the
// exact-dated postings come from.
//
//   npx tsx --conditions=react-server scripts/audit-deadlines.ts
import { openScriptDb } from "./_db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { parseTalentLinkDeadline } from "../src/lib/monitoring/connectors/talentlink";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor)";

function decode(t: string) {
  return t
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
const strip = (x: string) => decode(x.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "-");

async function main() {
  const { db, close: closeDb } = await openScriptDb();
  const firms = await db.select().from(schema.firms);
  const sources = await db.select().from(schema.firmMonitoringSources);
  const fname = new Map(firms.map((f) => [f.id, f.name]));

  const tal = sources.filter((s) => {
    try { return new URL(s.careersUrl).hostname.endsWith("tal.net"); } catch { return false; }
  });

  let checked = 0, agree = 0, disagree = 0, missing = 0;
  for (const s of tal) {
    const origin = new URL(s.careersUrl).origin;
    let xml = "";
    for (const i of [2, 1]) {
      const r = await fetch(`${origin}/candidate/jobboard/vacancy/${i}/feed`, { headers: { "user-agent": UA } });
      if (r.ok) { const b = await r.text(); if (/<entry[\s>]/.test(b)) { xml = b; break; } }
    }
    if (!xml) { console.log(`${fname.get(s.firmId)}: no feed`); continue; }

    const live = new Map<string, { title: string; deadline: Date | null; text: string }>();
    for (const e of xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? []) {
      const title = strip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(e)?.[1] ?? "");
      const content = strip(/<content[^>]*>([\s\S]*?)<\/content>/i.exec(e)?.[1] ?? "");
      const stated = /Application Deadline:?\s*([0-9A-Za-z:, ]{6,44})/i.exec(content)?.[1]?.trim() ?? "";
      if (title) live.set(title.toLowerCase().replace(/\s+/g, " "), { title, deadline: parseTalentLinkDeadline(content), text: stated });
    }

    // The exact dates live in opening_signals, not on the posting - that is
    // the bridge the Upcoming list reads. Matched on the evidence sentence,
    // which carries the role title the signal was read out of.
    const sigs = await db.select().from(schema.openingSignals).where(eq(schema.openingSignals.firmId, s.firmId));
    for (const sig of sigs.filter((x) => x.closesStart)) {
      checked++;
      const ev = (sig.evidence ?? "").toLowerCase();
      const hit = [...live.values()].find((v) => ev.includes(v.title.toLowerCase().slice(0, 34)))
        ?? [...live.values()].find((v) => v.deadline && day(v.deadline) === day(sig.closesStart as Date));
      if (!hit) { missing++; console.log(`  NOT IN FEED ${fname.get(s.firmId)}: stored=${day(sig.closesStart as Date)} cycle=${sig.cycleYear} ev="${(sig.evidence ?? "").slice(0, 58)}"`); continue; }
      const ours = day(sig.closesStart as Date), theirs = day(hit.deadline);
      if (ours === theirs) agree++;
      else { disagree++; console.log(`  MISMATCH ${fname.get(s.firmId)}: stored=${ours} feed=${theirs} ("${hit.text}") ${hit.title.slice(0, 46)}`); }
    }
  }
  console.log(`\nchecked ${checked}: agree ${agree}, disagree ${disagree}, not in feed ${missing}`);
  await closeDb();
}
main();
