// Retract postings that belong to another company entirely.
//
// A Getro board is a VENTURE FIRM'S PORTFOLIO job board: it lists openings at
// the firm's portfolio companies, not at the firm. The `getro` connector reads
// one as though it were the firm's own careers page, so every listing it finds
// is published under the wrong employer's name.
//
// Measured 12 October 2026 against the live database: 26 `getro` sources, four
// of them with live postings - 64 in total.
//
//   Group 11               55   every application_url is careers.munichre.com
//   Blockchain Capital      6   Coinbase roles (Product Design, Sales, User
//                               Research - not finance internships at all)
//   Oca Ventures            2
//   Rallyday Partners       1
//
// The handoff recorded this as "a source scraping Coinbase's Greenhouse board"
// affecting ~6 postings. That was the symptom at one firm; the cause is the
// connector treating an aggregator as a single employer, and it is 64.
//
// The application URL is what proves it: a posting whose apply link is on
// careers.munichre.com is Munich Re's, whatever board it was found on.
//
// WHAT IT WILL NOT DO
//  - `origin = 'crawler'` in the WHERE as well as the filter.
//  - Deactivates rather than deletes, so every row is recoverable.
//  - Touches only sources on a portfolio-board connector.
//
// Dry-run by default; writes a dated record under scripts/data/ before any
// update, because internship_postings keeps no history.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/retire-portfolio-board-postings.ts
//   ... --apply
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";

import { openScriptDb } from "./_db";
import * as schema from "../src/db/schema";
import { PORTFOLIO_BOARD_CONNECTORS } from "../src/lib/monitoring/portfolio-boards";

const APPLY = process.argv.includes("--apply");

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    const rows = await db
      .select({
        postingId: schema.internshipPostings.id,
        title: schema.internshipPostings.roleTitle,
        applicationUrl: schema.internshipPostings.applicationUrl,
        isActive: schema.internshipPostings.isActive,
        origin: schema.internshipPostings.origin,
        connectorId: schema.firmMonitoringSources.connectorId,
        firmName: schema.firms.name,
      })
      .from(schema.detectedListings)
      .innerJoin(
        schema.firmMonitoringSources,
        eq(schema.firmMonitoringSources.id, schema.detectedListings.sourceId),
      )
      .innerJoin(schema.firms, eq(schema.firms.id, schema.firmMonitoringSources.firmId))
      .innerJoin(
        schema.internshipPostings,
        eq(schema.internshipPostings.id, schema.detectedListings.promotedPostingId),
      );

    const doomed = rows.filter(
      (r) =>
        r.isActive &&
        r.origin === "crawler" &&
        PORTFOLIO_BOARD_CONNECTORS.has(r.connectorId),
    );

    const byFirm = new Map<string, number>();
    for (const d of doomed) byFirm.set(d.firmName, (byFirm.get(d.firmName) ?? 0) + 1);

    console.log(`${doomed.length} active postings come from a portfolio board:`);
    for (const [firm, n] of [...byFirm].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${firm}`);
    }
    for (const d of doomed.slice(0, 8)) {
      console.log(`  - ${d.firmName}: ${d.title.slice(0, 52)}`);
      console.log(`      apply -> ${String(d.applicationUrl ?? "").slice(0, 64)}`);
    }

    if (!APPLY) {
      console.log("\nDry run - nothing written. Pass --apply to retract.");
      return;
    }
    if (doomed.length === 0) {
      console.log("\nNothing to retract.");
      return;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const out = path.join(process.cwd(), "scripts/data", `portfolio-board-retracted-${stamp}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          why: "published under the board owner's name; the job belongs to a portfolio company",
          retracted: doomed,
        },
        null,
        2,
      ),
    );
    console.log(`\nRecorded ${doomed.length} postings to ${out}`);

    const ids = [...new Set(doomed.map((d) => d.postingId))];
    await db
      .update(schema.internshipPostings)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          inArray(schema.internshipPostings.id, ids),
          eq(schema.internshipPostings.origin, "crawler"),
        ),
      );
    console.log(`${ids.length} postings retracted.`);
  } finally {
    await closeDb();
  }
}

main();
