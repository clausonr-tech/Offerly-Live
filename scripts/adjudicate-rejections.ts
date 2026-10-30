// Give the title phrase list a second opinion, where it looks like it needs one.
//
// The goal stated by the user is ZERO incorrect rejections. The known failure
// is 42 French internships dropped because `Stage H/F - Private Equity` did
// not match a phrase, found by accident during an audit of something else.
// Every such rejection now records "not an internship: the title matched no
// internship phrase (...)", so the candidates are findable - this finds them.
//
// THREE THINGS IT WILL NOT DO
// ---------------------------
//  - It never publishes. A positive verdict records its evidence on the row
//    and leaves the status alone; it cannot reach `auto_approved`. See the
//    note at that write for why it no longer moves the row to pending_review.
//  - It never re-rejects. Listings the phrase list ACCEPTED are not touched.
//  - It never overrides a human. Rows with `reviewedBy` set are skipped, the
//    same distinction reclassify-listings.ts already makes between a machine
//    verdict and a person's.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/adjudicate-rejections.ts
//   ... --limit 25 --apply     to actually spend and write
//
// Without --apply this makes NO model calls at all - it counts what a run
// would cost, because the pre-filter is pure. Stop the dev server first.
import type { Db } from "../src/db/types";
import { openScriptDb } from "./_db";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import {
  adjudicateListing,
  looksPromising,
  extractCycleWithLlm,
  ADJUDICATION_BODY_LIMIT,
} from "../src/lib/monitoring/llm-adjudicate";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const APPLY = process.argv.includes("--apply");
const LIMIT = Number(arg("limit") ?? 25);

type Classification = { relevant?: boolean; reasonForUncertainty?: string };

/** The rejection shape this is for: the title matched no phrase. Anything
 *  rejected for a different reason was judged on evidence the adjudicator
 *  does not have. */
const TITLE_REJECTION = /no internship\/summer-program phrase matched|matched no internship phrase/i;

/**
 * The other half: postings that ARE relevant and are held back only because
 * no year could be found.
 *
 * classify.ts reads a stated year and derives one from a deadline or posting
 * date, both free. What reaches here states the year only in prose - and 122
 * of them were sitting in review, which is 122 real internships a student
 * cannot see for want of a number that is written in the text.
 *
 * Same contract as the adjudicator: quote verbatim or be discarded, and the
 * quote must contain the year it claims.
 */
async function adjudicateCycles(
  db: Db,
  apply: boolean,
  limit: number,
) {
  const rows = await db.select().from(schema.detectedListings);
  const stuck = rows.filter((row) => {
    if (row.reviewedBy) return false;
    /**
     * `rejected`, not `pending_review`.
     *
     * These 122 listings sat in the review queue until routing became binary
     * (see the BINARY note in scripts/monitor-run.ts). A relevant posting with
     * no readable year is now rejected WITH ITS REASON STATED, which is the
     * only thing this filter ever actually needed - `reasonForUncertainty` is
     * what identifies them, and it is written either way.
     *
     * Read against the old status this found nothing at all, silently: the
     * queue it was looking in stopped being written to, so the half of this
     * script that recovers real internships quietly became a no-op.
     */
    if (row.reviewStatus !== "rejected") return false;
    const c = row.classification as Classification | null;
    return c?.relevant === true && Boolean(c.reasonForUncertainty?.includes("recruiting-cycle"));
  });

  console.log(`${stuck.length} relevant listings have no recruiting cycle.`);
  if (!apply) {
    for (const row of stuck.slice(0, 15)) console.log(`  - ${row.title.slice(0, 74)}`);
    console.log("\nDry run - no model calls made. Pass --apply --limit N to spend.");
    return;
  }

  const batch = stuck.slice(0, limit);
  console.log(`Reading a cycle for ${batch.length} (limit ${limit})...\n`);

  let filled = 0;
  for (const row of batch) {
    const found = await extractCycleWithLlm({
      title: row.title,
      descriptionRaw: row.descriptionRaw ?? "",
    });
    if (!found) continue;

    filled += 1;
    console.log(`  + ${found.year}  ${row.title.slice(0, 62)}`);
    console.log(`    "${found.quote.slice(0, 120)}"`);

    const existing = (row.classification as Record<string, unknown> | null) ?? {};
    await db
      .update(schema.detectedListings)
      .set({
        classification: {
          ...existing,
          recruitingCycle: found.year,
          reasonForUncertainty: null,
          // The basis, kept where a reviewer can see it - a cycle read by a
          // model is not the same fact as a cycle the firm printed.
          cycleBasis: { source: "llm", quote: found.quote, at: new Date().toISOString() },
        },
        updatedAt: new Date(),
      })
      .where(eq(schema.detectedListings.id, row.id));
  }

  console.log(`\n${filled} of ${batch.length} now have a cycle.`);
}

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    if (process.argv.includes("--cycles")) {
      await adjudicateCycles(db, APPLY, LIMIT);
      return;
    }

    const rows = await db.select().from(schema.detectedListings);

    const candidates = rows.filter((row) => {
      if (row.reviewStatus !== "rejected") return false;
      // A person's verdict is not a machine's to revisit.
      if (row.reviewedBy) return false;
      const c = row.classification as Classification | null;
      return Boolean(c?.reasonForUncertainty && TITLE_REJECTION.test(c.reasonForUncertainty));
    });

    // Filtered on exactly the text the model will be shown, so a listing
    // cannot pass here and be skipped inside the call.
    const promising = candidates.filter((row) =>
      looksPromising(row.title, (row.descriptionRaw ?? "").slice(0, ADJUDICATION_BODY_LIMIT)),
    );

    console.log(`${rows.length} listings, ${candidates.length} rejected on title alone.`);
    console.log(
      `${promising.length} of those carry student language in the body - ` +
        `those are the only ones worth a model call.`,
    );
    console.log(
      `The pre-filter is free, so it just saved ${candidates.length - promising.length} calls.\n`,
    );

    if (!APPLY) {
      console.log("Sample of what WOULD be asked about:");
      for (const row of promising.slice(0, 15)) {
        console.log(`  - ${row.title.slice(0, 80)}`);
      }
      console.log(`\nDry run - no model calls made. Pass --apply --limit N to spend.`);
      return;
    }

    const batch = promising.slice(0, LIMIT);
    console.log(`Adjudicating ${batch.length} (limit ${LIMIT})...\n`);

    let recovered = 0;
    const outcomes: Record<string, number> = {};
    const problems: string[] = [];

    for (const row of batch) {
      const result = await adjudicateListing({
        title: row.title,
        descriptionRaw: row.descriptionRaw ?? "",
      });

      outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;

      if (result.outcome === "failed" || result.outcome === "unverified") {
        // Surfaced rather than counted silently - a run of these means the
        // key is wrong or the model is drifting, not that the listings were
        // all correctly rejected.
        problems.push(`${result.outcome}: ${result.reason} (${row.title.slice(0, 50)})`);
        continue;
      }
      if (result.outcome !== "internship") continue;

      const verdict = result.adjudication;
      recovered += 1;
      console.log(`  + ${row.title.slice(0, 70)}`);
      console.log(`    "${verdict.quote.slice(0, 140)}"`);

      const existing = (row.classification as Record<string, unknown> | null) ?? {};
      await db
        .update(schema.detectedListings)
        .set({
          /**
           * THE VERDICT IS RECORDED; THE STATUS IS NOT MOVED.
           *
           * This wrote `pending_review`, on the contract stated at the top of
           * this file: it never publishes, because a model saying "yes, an
           * internship" is not the same fact as a firm printing it. That
           * contract stands. What changed is where the row landed - routing is
           * binary now, and `pending_review` is a queue nothing works:
           * `reviewed_by` was NULL on all 21,716 rows when it was removed.
           * Writing it moved a recovered listing from one invisible state to
           * another, while reading as though a person would see it.
           *
           * So the row stays `rejected` and the evidence goes where it can be
           * acted on. That is not a loss against what used to happen: nothing
           * was ever promoted out of that queue in the system's history.
           *
           * OPEN QUESTION FOR THE OWNER, deliberately not answered here: how an
           * adjudicated recovery reaches a student at all. `relevant: true` plus
           * a verbatim quote is the evidence a promotion would need, and
           * `reclassify-listings.ts` already re-decides a machine rejection on
           * `publishableWithoutReview`. Wiring these together would let a model
           * verdict publish, which is exactly the decision "only real postings
           * reach students" reserves for a person.
           */
          classification: {
            ...existing,
            relevant: true,
            // The evidence, kept where a reviewer can see it. The whole
            // reason the original 42 stayed lost is that their reason lived
            // in a field nobody read.
            adjudication: {
              isInternship: true,
              quote: verdict.quote,
              titleReason: verdict.titleReason,
              at: new Date().toISOString(),
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(schema.detectedListings.id, row.id));
    }

    console.log(`\n${recovered} adjudicated as internships - evidence recorded, still rejected.`);
    console.log("outcomes:");
    for (const [outcome, n] of Object.entries(outcomes).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${outcome}`);
    }
    if (problems.length) {
      console.log("\nproblems (these are NOT the model saying no):");
      for (const p of problems.slice(0, 10)) console.log(`  - ${p}`);
    }
  } finally {
    await closeDb();
  }
}

main();
