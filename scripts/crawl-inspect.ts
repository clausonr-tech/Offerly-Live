// Dump stored postings to eyeball crawl quality. Stop the dev server first.
//   npx tsx --conditions=react-server scripts/crawl-inspect.ts

import { openScriptDb } from "./_db";
async function main() {
  const { db } = await openScriptDb();
  const postings = await db.query.internshipPostings.findMany();

  console.log(`${postings.length} posting(s) stored\n`);
  for (const p of postings) {
    console.log(`— ${p.roleTitle}`);
    console.log(`   year=${p.programYear} eligible=[${p.eligibleGradYears}] status=${p.deadlineStatus}`);
    console.log(`   deadlineText: ${p.deadlineText ?? "(none)"}`);
    console.log(`   location: ${p.location ?? "(none)"}`);
    console.log(`   recruiter: ${p.recruiterName ?? "-"} | ${p.recruiterEmail ?? "-"} | ${p.recruiterPhone ?? "-"}`);
    console.log(`   source: ${p.sourceUrl}`);
    console.log(`   description: ${p.descriptionFull.length} chars — "${p.descriptionFull.slice(0, 110).replace(/\s+/g, " ")}..."`);
    console.log("");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
