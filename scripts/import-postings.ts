// Imports internship postings from a JSON file into internship_postings.
//
// This is the write path for the in-session crawl: Claude Code researches
// firms with its own web tools (no API-key spend) and drops findings here,
// rather than the paid crawler script doing the discovery.
//
//   npx tsx --conditions=react-server scripts/import-postings.ts <file.json>
//
// Stop the dev server first — this opens the PGlite directory directly.
//
// Expected shape: an array of objects. firmName must match firms.name exactly;
// unmatched firms are reported and skipped rather than silently dropped.
import { openScriptDb } from "./_db";
import { readFileSync } from "fs";
import { and, eq } from "drizzle-orm";
// Every write below is limited to origin = "crawler": a posting a firm wrote
// itself on the firm portal is the firm's, and no script may change it.
import * as schema from "../src/db/schema";

type Incoming = {
  firmName: string;
  /** Every industry the posting belongs to. A bare `category` string is still
   *  accepted so files written before the column became an array still load. */
  categories?: string[];
  category?: string;
  roleTitle: string;
  location?: string | null;
  programYear: number;
  eligibleGradYears: number[];
  deadlineStatus: "tbd" | "confirmed" | "rolling" | "closed";
  deadlineText?: string | null;
  deadlineDateIso?: string | null;
  descriptionFull: string;
  sourceUrl: string;
  applicationUrl?: string | null;
  recruiterName?: string | null;
  recruiterTitle?: string | null;
  recruiterEmail?: string | null;
  recruiterPhone?: string | null;
};

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: import-postings.ts <file.json>");
    process.exit(1);
  }

  const rows: Incoming[] = JSON.parse(readFileSync(path, "utf8"));
  const { db } = await openScriptDb();

  const firms = await db.query.firms.findMany();
  const byName = new Map(firms.map((f) => [f.name, f.id]));

  // Descriptions must be paraphrased, never the firm's posting text. Same
  // heuristic as the crawler's write path — catches boilerplate that only
  // survives copy-paste.
  const COPY_MARKERS = [
    /equal opportunity employer/i,
    /all qualified applicants will receive consideration/i,
    /\bresponsibilities\s*:/i,
    /\bqualifications\s*:/i,
    /\bwhat you'?ll do\b/i,
    /\babout (us|the (role|team|firm))\b/i,
    /reasonable accommodation/i,
    /without regard to race/i,
  ];

  let inserted = 0;
  let updated = 0;
  const unmatched: string[] = [];
  const suspected: string[] = [];

  for (const r of rows) {
    const firmId = byName.get(r.firmName);
    if (!firmId) {
      unmatched.push(r.firmName);
      continue;
    }

    const marker = COPY_MARKERS.find((re) => re.test(r.descriptionFull));
    if (marker) {
      suspected.push(`${r.firmName} — ${r.roleTitle} (matched ${marker})`);
    }

    const categories = (r.categories ?? (r.category ? [r.category] : [])).filter(
      (c): c is (typeof schema.firmProgramCategoryEnum.enumValues)[number] =>
        (schema.firmProgramCategoryEnum.enumValues as readonly string[]).includes(c),
    );
    if (!categories.length) {
      unmatched.push(`${r.firmName} — ${r.roleTitle} (no valid category)`);
      continue;
    }

    const values = {
      firmId,
      categories: [...new Set(categories)],
      roleTitle: r.roleTitle,
      location: r.location ?? null,
      programYear: r.programYear,
      eligibleGradYears: r.eligibleGradYears,
      deadlineStatus: r.deadlineStatus,
      deadlineText: r.deadlineText ?? null,
      deadlineDate: r.deadlineDateIso ? new Date(r.deadlineDateIso) : null,
      descriptionFull: r.descriptionFull,
      sourceUrl: r.sourceUrl,
      applicationUrl: r.applicationUrl ?? null,
      recruiterName: r.recruiterName ?? null,
      recruiterTitle: r.recruiterTitle ?? null,
      recruiterEmail: r.recruiterEmail ?? null,
      recruiterPhone: r.recruiterPhone ?? null,
      isActive: true,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    };

    // Same identity as the paid crawler: firm + role + program year.
    const existing = await db.query.internshipPostings.findFirst({
      where: and(
        eq(schema.internshipPostings.firmId, firmId),
        eq(schema.internshipPostings.roleTitle, r.roleTitle),
        eq(schema.internshipPostings.programYear, r.programYear),
      ),
      columns: { id: true },
    });

    if (existing) {
      await db
        .update(schema.internshipPostings)
        .set(values)
        .where(and(eq(schema.internshipPostings.id, existing.id), eq(schema.internshipPostings.origin, "crawler")));
      updated += 1;
    } else {
      await db.insert(schema.internshipPostings).values(values);
      inserted += 1;
    }
  }

  console.log(`${inserted} inserted, ${updated} updated`);
  if (suspected.length > 0) {
    console.log(
      `\nWARNING — ${suspected.length} description(s) contain posting boilerplate and may be copied rather than paraphrased. Review these:`,
    );
    for (const s of suspected) console.log(`  - ${s}`);
  }
  if (unmatched.length > 0) {
    console.log(`\nUnmatched firm names (skipped) — fix these to match firms.name:`);
    for (const n of [...new Set(unmatched)]) console.log(`  - ${n}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
