// What the classifier got wrong, and which postings are still missing a cycle.
//
// The read side of classifier_feedback. A table nobody can query is not a
// record, and the two questions worth asking of it are:
//
//   disagreements  where did a reviewer overrule the machine? Those are, by
//                  definition, the cases the rules get wrong, and a phrase
//                  that shows up repeatedly is one the phrase list should learn.
//   cycles         which relevant postings still have no recruiting cycle, and
//                  would therefore sit in review rather than reaching students?
//
// Report only. Nothing here changes behaviour - a classifier that retrains on
// its own reviewer's clicks drifts quickly and silently, and this pipeline's
// whole design is that rules are explicit and explainable.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/classifier-report.ts [disagreements|cycles]
//
// Read-only. Stop the dev server first.
import { openScriptDb } from "./_db";
import * as schema from "../src/db/schema";

const WHICH = process.argv[2] ?? "all";

type Classification = { relevant?: boolean; reasonForUncertainty?: string | null; confidence?: number };

async function main() {
  const { db, close: closeDb } = await openScriptDb();

  try {
    if (WHICH === "all" || WHICH === "disagreements") {
      const rows = await db.select().from(schema.classifierFeedback);
      const disagreed = rows.filter((r) => r.disagreed);

      console.log(`\n===== reviewer disagreements =====`);
      console.log(`${rows.length} reviews recorded, ${disagreed.length} disagreements.`);

      if (!rows.length) {
        // Said plainly rather than printed as a zero, because the two look
        // identical in a report and mean entirely different things.
        console.log(
          "No reviews yet - reviewedBy is null on every listing, so the admin queue has not been used.\n" +
            "This fills as people work the queue; nothing is wrong.",
        );
      } else {
        const rate = ((disagreed.length / rows.length) * 100).toFixed(1);
        console.log(`disagreement rate: ${rate}%`);

        // A machine "yes" a human rejected is the dangerous direction - it
        // reached a student. Listed first and separately.
        const falsePositives = disagreed.filter((r) => r.machineRelevant);
        const falseNegatives = disagreed.filter((r) => !r.machineRelevant);

        if (falsePositives.length) {
          console.log(`\n  published but rejected by a reviewer (${falsePositives.length}) - these reached students:`);
          for (const r of falsePositives.slice(0, 20)) {
            console.log(`    ${r.title.slice(0, 70)}`);
            console.log(`      machine said relevant, confidence ${r.machineConfidence ?? "?"}`);
          }
        }
        if (falseNegatives.length) {
          console.log(`\n  rejected by the machine, approved by a reviewer (${falseNegatives.length}) - phrase-list candidates:`);
          for (const r of falseNegatives.slice(0, 20)) {
            console.log(`    ${r.title.slice(0, 70)}`);
            console.log(`      machine reason: ${r.machineReason ?? "(none)"}`);
          }
        }
      }
    }

    if (WHICH === "all" || WHICH === "cycles") {
      const listings = await db.select().from(schema.detectedListings);
      const stuck = listings.filter((l) => {
        const c = l.classification as Classification | null;
        return (
          l.reviewStatus === "pending_review" &&
          c?.relevant === true &&
          Boolean(c.reasonForUncertainty?.includes("recruiting-cycle"))
        );
      });

      console.log(`\n===== relevant postings with no recruiting cycle =====`);
      console.log(
        `${stuck.length} listings are relevant, have a sector, and are held back only for want of a year.`,
      );
      if (stuck.length) {
        console.log(
          "classify.ts now derives a cycle from a stated deadline or posting date. What remains here\n" +
            "states the year only in prose - which is what extractCycleWithLlm in llm-adjudicate.ts is for.",
        );
        for (const l of stuck.slice(0, 20)) console.log(`    ${l.title.slice(0, 74)}`);
        if (stuck.length > 20) console.log(`    ... and ${stuck.length - 20} more`);
      }
    }
  } finally {
    await closeDb();
  }
}

main();
