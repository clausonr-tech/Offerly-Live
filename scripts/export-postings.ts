// Exports every stored internship posting to CSV for human review.
//   npx tsx --conditions=react-server scripts/export-postings.ts [outfile]
// Defaults to ./internship-postings.csv. Stop the dev server first.
import { openScriptDb } from "./_db";
import { writeFileSync } from "fs";
import { isSkeletonPosting } from "@/lib/internship-postings";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/\r?\n/g, " ").trim();
  return `"${s.replace(/"/g, '""')}"`;
}

async function main() {
  const out = process.argv[2] ?? "./internship-postings.csv";
  const { db } = await openScriptDb();

  const firms = await db.query.firms.findMany();
  const firmName = new Map(firms.map((f) => [f.id, f.name]));
  const postings = await db.query.internshipPostings.findMany();

  postings.sort(
    (a, b) =>
      (firmName.get(a.firmId) ?? "").localeCompare(firmName.get(b.firmId) ?? "") ||
      a.roleTitle.localeCompare(b.roleTitle),
  );

  const headers = [
    "firm",
    "role_title",
    // Space-separated, matching eligible_grad_years — a posting can sit in
    // several industries. The importer still accepts the old single-valued
    // "category" header so previously exported files keep loading.
    "categories",
    "program_year",
    "eligible_grad_years",
    "deadline_status",
    "deadline_date",
    "deadline_text",
    "location",
    "description_captured",
    "description_full",
    "source_url",
    "application_url",
    "recruiter_name",
    "recruiter_title",
    "recruiter_email",
    "recruiter_phone",
    "is_active",
    "last_checked_at",
  ];

  const lines = [headers.join(",")];
  for (const p of postings) {
    // Flag rows still carrying the placeholder, so review can focus on gaps.
    const captured = isSkeletonPosting(p)
      ? "NO - placeholder"
      : "yes";
    lines.push(
      [
        firmName.get(p.firmId) ?? "(unknown firm)",
        p.roleTitle,
        (p.categories ?? []).join(" "),
        p.programYear,
        (p.eligibleGradYears ?? []).join(" "),
        p.deadlineStatus,
        p.deadlineDate ? new Date(p.deadlineDate).toISOString().slice(0, 10) : "",
        p.deadlineText,
        p.location,
        captured,
        p.descriptionFull,
        p.sourceUrl,
        p.applicationUrl,
        p.recruiterName,
        p.recruiterTitle,
        p.recruiterEmail,
        p.recruiterPhone,
        p.isActive,
        new Date(p.lastCheckedAt).toISOString().slice(0, 10),
      ]
        .map(csvCell)
        .join(","),
    );
  }

  writeFileSync(out, lines.join("\n"), "utf8");

  const withDesc = postings.filter((p) => !isSkeletonPosting(p)).length;
  console.log(`${postings.length} posting(s) exported to ${out}`);
  console.log(`  ${withDesc} with a real description, ${postings.length - withDesc} still placeholder`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
