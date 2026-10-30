/**
 * Writes the deadline each posting already states into the columns that are
 * read.
 *
 * The date was never missing. promote-approved-listings.ts publishes every row
 * with `deadlineStatus: "tbd"` because detected_listings does not carry a
 * closing date across from the connector - but the crawler captures the firm's
 * page text, and for TalentLink boards that text opens with the deadline:
 *
 *     Application Deadline:15 Nov 2026 11:55 PM EST
 *
 * Nothing read it on the way in, so the Internships tab said "Deadline TBD"
 * while the Top applications panel - which parses the same sentence at render
 * time - counted down to it. Measured on Supabase, 22 September 2026: 117
 * active postings state a deadline and all 117 were filed "tbd".
 *
 * TWO SOURCES, same order of precedence as lib/monitoring/publishable.ts:
 *
 *   1. detected_listings.deadline_at - the connector read it as DATA. This is
 *      the only path that recovers Dayforce and Oracle boards, whose expiry
 *      dates are API fields and appear nowhere in the description text.
 *   2. the description's own sentence, for everything else.
 *
 * savePosting and the promote step now do this for anything published from
 * here on. This is the one-time pass over what is already stored.
 *
 * Deliberately narrow: it only ever moves a row OFF "tbd", and only when the
 * posting's own words give an unambiguous date (see lib/posting-deadline.ts,
 * which refuses a per-region list, a date with no year, and two different
 * stated deadlines). A row somebody has already given a status is left alone.
 *
 * Read-only unless you pass --apply:
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/backfill-stated-deadlines.ts
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/backfill-stated-deadlines.ts --apply
 */
import { and, eq, isNotNull } from "drizzle-orm";
// Every write below is limited to origin = "crawler": a posting a firm wrote
// itself on the firm portal is the firm's, and no script may change it.
import { getDb } from "@/db/client";
import { detectedListings, firmMonitoringSources, firms, internshipPostings } from "@/db/schema";
import { deadlineColumnsFromText } from "@/lib/posting-deadline";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = await getDb();

  const rows = await db
    .select({
      id: internshipPostings.id,
      firmId: internshipPostings.firmId,
      firm: firms.name,
      roleTitle: internshipPostings.roleTitle,
      programYear: internshipPostings.programYear,
      deadlineStatus: internshipPostings.deadlineStatus,
      deadlineDate: internshipPostings.deadlineDate,
      descriptionFull: internshipPostings.descriptionFull,
    })
    .from(internshipPostings)
    .innerJoin(firms, eq(internshipPostings.firmId, firms.id))
    .where(eq(internshipPostings.isActive, true));

  /**
   * What the CONNECTOR read, keyed the way the promote step matches: the
   * firm behind the monitoring source, plus the listing title, which is the
   * posting's roleTitle verbatim.
   */
  const connectorDeadline = new Map<string, Date>();
  for (const d of await db
    .select({
      firmId: firmMonitoringSources.firmId,
      title: detectedListings.title,
      deadlineAt: detectedListings.deadlineAt,
    })
    .from(detectedListings)
    .innerJoin(firmMonitoringSources, eq(firmMonitoringSources.id, detectedListings.sourceId))
    .where(isNotNull(detectedListings.deadlineAt))) {
    if (d.deadlineAt) connectorDeadline.set(`${d.firmId}|${d.title}`, d.deadlineAt);
  }

  const now = new Date();
  const updates: {
    id: string;
    label: string;
    status: "confirmed" | "closed";
    date: Date;
    from: "connector" | "text";
  }[] = [];
  let statedButUnreadable = 0;

  for (const r of rows) {
    // Never overrule a decision somebody already made.
    if (r.deadlineStatus !== "tbd" || r.deadlineDate) continue;

    const label = `${r.firm} — ${r.roleTitle.slice(0, 64)} (Summer ${r.programYear})`;

    // 1. the connector's own date, which no amount of text parsing recovers.
    const fromConnector = connectorDeadline.get(`${r.firmId}|${r.roleTitle}`);
    if (fromConnector) {
      updates.push({
        id: r.id,
        label,
        status: fromConnector.getTime() > now.getTime() ? "confirmed" : "closed",
        date: fromConnector,
        from: "connector",
      });
      continue;
    }

    // 2. the posting's own sentence.
    const stated = deadlineColumnsFromText(r.descriptionFull, now);
    if (!stated) {
      if (/application\s+deadline/i.test(r.descriptionFull)) statedButUnreadable++;
      continue;
    }
    updates.push({ id: r.id, label, status: stated.deadlineStatus, date: stated.deadlineDate, from: "text" });
  }

  const confirmed = updates.filter((u) => u.status === "confirmed");
  const closed = updates.filter((u) => u.status === "closed");

  console.log(`\nactive postings:                       ${rows.length}`);
  console.log(`rows to date:                          ${updates.length}`);
  console.log(`   deadline still ahead -> confirmed:  ${confirmed.length}`);
  console.log(`   deadline already passed -> closed:  ${closed.length}`);
  console.log(`   from the connector, as data:        ${updates.filter((u) => u.from === "connector").length}`);
  console.log(`   read out of the posting's own text:  ${updates.filter((u) => u.from === "text").length}`);
  console.log(`states a deadline we will NOT read:    ${statedButUnreadable} (left tbd on purpose)`);

  const byYear = new Map<string, number>();
  for (const u of updates) {
    const y = u.label.match(/Summer (\d{4})/)?.[1] ?? "?";
    byYear.set(y, (byYear.get(y) ?? 0) + 1);
  }
  console.log("\nby cycle:");
  for (const [y, n] of [...byYear].sort()) console.log(`   ${y}: ${n}`);

  console.log("\nsample:");
  for (const u of updates.slice(0, 6)) {
    console.log(`   ${u.date.toISOString().slice(0, 10)}  ${u.status.padEnd(9)}  ${u.label}`);
  }

  if (!APPLY) {
    console.log("\nDRY RUN - nothing written. Re-run with --apply.");
    return;
  }

  for (const u of updates) {
    await db
      .update(internshipPostings)
      .set({ deadlineStatus: u.status, deadlineDate: u.date, updatedAt: new Date() })
      .where(and(eq(internshipPostings.id, u.id), eq(internshipPostings.origin, "crawler")));
  }
  console.log(`\nDated ${updates.length} postings.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
