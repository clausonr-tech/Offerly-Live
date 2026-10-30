// Run the current classifier over every stored listing and see what it does.
//
// The unit tests prove the rules. This proves the SYSTEM: 2,658 real postings
// from 14 connectors, classified again with the code as it stands, compared
// against what was stored, and audited for answers that look wrong.
//
// Three questions:
//   1. What CHANGED since these rows were classified? A change is either an
//      improvement or a regression, and both are worth seeing by name.
//   2. Does anything classified relevant look obviously wrong - a tax role, a
//      technology role, an event?
//   3. Does every rejection still state a reason?
//
// Read-only. Writes nothing.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/verify-classifier-corpus.ts
import { openScriptDb } from "./_db";
import * as schema from "../src/db/schema";
import { classifyListing } from "../src/lib/monitoring/classify";

type Stored = { relevant?: boolean; recruitingCycle?: number | null; reasonForUncertainty?: string | null };

/**
 * Shapes that should NEVER come back relevant.
 *
 * Deliberately written in the languages the corpus actually contains - the
 * off-profession and off-technology rules are English-only, and this corpus
 * has French and German postings in it. If one of these matches something
 * classified relevant, that is a hole in a rule rather than a quirk of a row.
 */
const SHOULD_NEVER_BE_RELEVANT: { name: string; re: RegExp }[] = [
  { name: "tax / transfer pricing", re: /\b(transfer pricing|tax|fiscalit|steuer|trade and customs|vat|indirect tax)\b/i },
  { name: "audit / assurance", re: /\b(audit|assurance|wirtschaftspr|r[eé]vision comptable)\b/i },
  { name: "technology", re: /\b(software|ing[eé]nieur\s+(ia|logiciel|informatique)|entwickler|d[eé]veloppeur|data scien|machine learning|cyber ?security|s[eé]curit[eé] informatique|devops|qa engineer|test engineer)\b/i },
  { name: "recruiting event", re: /\b(coffee chat|networking|info(rmation)? session|open day|career fair|webinar|fireside|panel|reception|journ[eé]e portes)\b/i },
  // --- categories added for the wider pass -----------------------------
  { name: "legal", re: /\b(paralegal|legal counsel|attorney|solicitor|juriste|rechtsanwalt|law clerk)\b/i },
  // "Campus Recruiting" is the DEPARTMENT that posts a role, not the role -
  // "2027 Campus Recruiting - Investment Banking Summer Associate" is a real
  // banking internship. Only the HR role words count, and a title that also
  // names a finance function is exempted below.
  { name: "human resources", re: /\b(human resources|talent acquisition|people team|ressources humaines|personalwesen|hr (analyst|intern))\b/i },
  { name: "facilities / admin", re: /\b(janitor|facilities|security guard|receptionist|barista|cleaner|driver|warehouse|logistik|kommissionier|verkaufsaushilfe)\b/i },
  { name: "clinical / lab", re: /\b(nurse|clinical|laboratory|veterinar|pharmac|medical (doctor|assistant))\b/i },
  { name: "seniority (non-English)", re: /\b(senior|leitende|directeur|responsable|chef de|abteilungsleiter)\b/i },
  { name: "full-time (non-English)", re: /\b(temps plein|vollzeit|cdi\b|festanstellung)\b/i },
  { name: "graduate scheme", re: /\b(graduate (programme|program|scheme)|absolventenprogramm)\b/i },
  // NOT listed: marketing and sales. Flagged on the first wide pass and
  // decided IN SCOPE (19 September 2026) - distribution is a core asset and
  // wealth management career, and this directory covers AWM. "2027 Investment
  // Management Off-Cycle Internship - Global Sales & Marketing" is a real
  // opening a student here would want. Recorded so the next audit does not
  // rediscover it as a bug.
  //
  // NOT listed: apprenticeships. "2027 Apprentice Financial Advisor Program"
  // is a finance role; the bare category page "Apprenticeships" is caught by
  // the quality gate as a programme family, which is the right layer for it.
];

/**
 * The other direction: rejected listings that read like real internships.
 *
 * A false positive is the dangerous error and gets most of the attention, but
 * a false negative is the invisible one - 42 French internships sat rejected
 * for months because nobody was looking. These patterns describe titles that
 * are almost certainly student roles, so a REJECTED listing matching one is
 * worth a human's eye.
 */
const SHOULD_PROBABLY_BE_RELEVANT: { name: string; re: RegExp }[] = [
  { name: "explicit internship word", re: /\b(internship|summer analyst|summer associate|praktikum|werkstudent|stagiaire|becario|tirocinio|practicas)\b/i },
  { name: "student eligibility in the title", re: /\b(penultimate|undergraduate|sophomore|rising (junior|senior)|first year student)\b/i },
  { name: "insight / spring week", re: /\b(spring week|insight (week|programme|program)|discovery (day|programme))\b/i },
];

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const sources = await db.select().from(schema.firmMonitoringSources);
    const sectorBySource = new Map(sources.map((s) => [s.id, s.sectorCategory]));
    const listings = await db.select().from(schema.detectedListings);

    let sameCount = 0;
    const nowRelevant: string[] = [];
    const nowRejected: string[] = [];
    const cycleGained: string[] = [];
    const noReason: string[] = [];
    const suspicious: { rule: string; title: string }[] = [];
    const missed: { rule: string; title: string }[] = [];

    for (const row of listings) {
      const stored = (row.classification ?? {}) as Stored;
      const result = classifyListing(
        {
          externalJobId: row.externalJobId,
          title: row.title,
          division: row.division,
          location: row.location,
          descriptionRaw: row.descriptionRaw ?? "",
          employmentType: row.employmentType,
          applicationUrl: row.applicationUrl,
          listingUrl: row.listingUrl,
          publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
          deadlineAt: row.deadlineAt ? row.deadlineAt.toISOString() : null,
        },
        (sectorBySource.get(row.sourceId) ?? null) as never,
      );

      if (result.relevant === stored.relevant) sameCount += 1;
      else if (result.relevant) nowRelevant.push(row.title);
      else nowRejected.push(row.title);

      if (result.recruitingCycle && !stored.recruitingCycle) {
        cycleGained.push(`${result.recruitingCycle}  ${row.title.slice(0, 60)}`);
      }

      if (!result.relevant) {
        const hasReason =
          Boolean(result.reasonForUncertainty) ||
          result.matchedEvidence.some(
            (e) => e.includes("not a posting") || e.includes("not an internship") || e.includes("excluded:") || e.includes("cycle"),
          );
        if (!hasReason) noReason.push(row.title);
      }

      const haystack = `${row.title} ${row.division ?? ""}`;
      /**
       * A title naming a finance function is not off-profession because it
       * also contains a support word. The role is what the title leads with.
       */
      const namesFinance =
        /\b(investment bank|m&a|mergers|capital markets|equity research|sales (and|&) trading|private equity|asset management|wealth management|restructuring|leveraged finance|corporate finance|valuation)\b/i.test(
          haystack,
        );

      if (result.relevant) {
        for (const rule of SHOULD_NEVER_BE_RELEVANT) {
          if (!rule.re.test(haystack)) continue;
          // Technology, tax and events are excluded even inside a finance
          // title - a Software Developer in IB is still a technology role.
          const overridable = ["human resources", "legal", "seniority (non-English)"].includes(rule.name);
          if (overridable && namesFinance) continue;
          suspicious.push({ rule: rule.name, title: row.title });
        }
      } else {
        // Only count a missed internship when NOTHING explains the rejection
        // as deliberate - an off-profession or event exclusion firing on a
        // title containing "internship" is the system working, not failing.
        const deliberate = result.matchedEvidence.some(
          (e) => e.includes("excluded:") || e.includes("not a posting") || e.includes("cycle"),
        );
        if (!deliberate) {
          for (const rule of SHOULD_PROBABLY_BE_RELEVANT) {
            if (rule.re.test(haystack)) missed.push({ rule: rule.name, title: row.title });
          }
        }
      }
    }

    console.log(`${listings.length} listings re-classified.\n`);
    console.log(`unchanged verdicts:        ${sameCount}`);
    console.log(`newly RELEVANT:            ${nowRelevant.length}`);
    console.log(`newly REJECTED:            ${nowRejected.length}`);
    console.log(`gained a recruiting cycle: ${cycleGained.length}`);
    console.log(`rejected with no reason:   ${noReason.length}`);
    console.log(`suspicious relevants:      ${suspicious.length}`);
    console.log(`possibly missed:           ${missed.length}`);

    if (nowRelevant.length) {
      console.log(`\nNEWLY RELEVANT - each of these now reaches a student, so each should be right:`);
      for (const t of nowRelevant.slice(0, 25)) console.log(`  ${t.slice(0, 78)}`);
      if (nowRelevant.length > 25) console.log(`  ... and ${nowRelevant.length - 25} more`);
    }
    if (nowRejected.length) {
      console.log(`\nNEWLY REJECTED - a regression if any of these is a real internship:`);
      for (const t of nowRejected.slice(0, 20)) console.log(`  ${t.slice(0, 78)}`);
    }
    if (cycleGained.length) {
      console.log(`\nCYCLE NOW DERIVED (first 12):`);
      for (const t of cycleGained.slice(0, 12)) console.log(`  ${t}`);
    }
    if (suspicious.length) {
      const byRule = new Map<string, string[]>();
      for (const s of suspicious) byRule.set(s.rule, [...(byRule.get(s.rule) ?? []), s.title]);
      console.log(`\nSUSPICIOUS - classified relevant but matching a rule that should exclude them:`);
      for (const [rule, titles] of byRule) {
        console.log(`  ${rule} (${titles.length}):`);
        for (const t of [...new Set(titles)].slice(0, 6)) console.log(`      ${t.slice(0, 72)}`);
      }
    }
    if (missed.length) {
      const byRule = new Map<string, string[]>();
      for (const m of missed) byRule.set(m.rule, [...(byRule.get(m.rule) ?? []), m.title]);
      console.log(`\nPOSSIBLY MISSED - rejected with no deliberate exclusion, but reads like a student role:`);
      for (const [rule, titles] of byRule) {
        console.log(`  ${rule} (${titles.length}):`);
        for (const t of [...new Set(titles)].slice(0, 8)) console.log(`      ${t.slice(0, 72)}`);
      }
    }

    if (noReason.length) {
      console.log(`\nREJECTED WITH NO READABLE REASON (${noReason.length}):`);
      for (const t of noReason.slice(0, 10)) console.log(`  ${t.slice(0, 78)}`);
    }
  } finally {
    await closeDb();
  }
}

main();
