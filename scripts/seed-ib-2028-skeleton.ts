// Emits a trackable skeleton row for every investment-banking program, for the
// summer 2028 cycle (class of 2029).
//
//   npx tsx --conditions=react-server scripts/seed-ib-2028-skeleton.ts > /tmp/ib-2028.json
//   npx tsx --conditions=react-server scripts/import-postings.ts /tmp/ib-2028.json
//
// Why a skeleton: as of August 2026 no firm has opened summer 2028
// applications (bulge brackets opened the 2027 cycle in Dec 2025 - Jan 2026,
// so 2028 is expected around Dec 2026 - Jan 2027). There is nothing to scrape
// yet, but the *programs* are stable and known, so this builds the list to
// track now and fill in as postings go live.
//
// descriptionFull is deliberately marked as not-yet-captured rather than
// invented. Many bank career sites block automated retrieval (403/timeout),
// and a fabricated description would be worse than an honest placeholder.

import { openScriptDb } from "./_db";
const PROGRAM_YEAR = 2028;
const ELIGIBLE_GRAD_YEARS = [2029];

const TIMING =
  "Summer 2028 applications are not open yet. Bulge-bracket firms opened their summer 2027 cycle between December 2025 and January 2026, so expect summer 2028 to open around December 2026 - January 2027. Verify on the firm's own page.";

// The directory tags some non-finance programs as investment_banking —
// technology, engineering, and operations tracks that happen to sit inside a
// bank's IB division. Those are excluded per the finance-only rule.
//
// Matched on exact roleLabel rather than a keyword regex on purpose: a regex
// for "technology" also strips "M&A Advisory (Technology, US)", which is
// tech-SECTOR coverage and very much a finance role.
const EXCLUDED_ROLE_LABELS = new Set([
  "CIB Chief Operating Office (Operations)",
  "Engineering / Technology",
  "Global Operations",
  "Global Technology",
  "Group Technology",
  "Operations",
  "Operations / Company (Finance, Audit, Risk, Legal, Compliance, HR)",
  "Operations / Treasury & Trade Solutions / Securities Services",
  "Technology",
  "Technology (App Dev, Cybersecurity, Infrastructure)",
  "Technology (Software Engineering, Cybersecurity, Data)",
  "Technology, Data & Innovation",
]);

const DESCRIPTION_PENDING =
  "Program description not yet captured. The summer 2028 posting is not live, and this firm's careers site has not yet been read directly. Use the source link for the firm's own program page; this entry will be filled in when the posting opens.";

async function main() {
  const { db } = await openScriptDb();
  const firms = await db.query.firms.findMany({ with: { programs: true } });
  firms.sort((a, b) => a.name.localeCompare(b.name));

  const rows = [];
  for (const firm of firms) {
    for (const p of firm.programs) {
      if (p.category !== "investment_banking") continue;
      if (EXCLUDED_ROLE_LABELS.has(p.roleLabel)) continue;
      rows.push({
        firmName: firm.name,
        category: p.category,
        roleTitle: `${p.roleLabel} - Summer Analyst`,
        location: null,
        programYear: PROGRAM_YEAR,
        eligibleGradYears: ELIGIBLE_GRAD_YEARS,
        deadlineStatus: "tbd",
        deadlineText: p.timingGuidance
          ? `${p.timingGuidance} ${TIMING}`
          : TIMING,
        deadlineDateIso: null,
        descriptionFull: DESCRIPTION_PENDING,
        sourceUrl: p.careersUrl,
        applicationUrl: p.careersUrl,
        recruiterName: null,
        recruiterTitle: null,
        recruiterEmail: null,
        recruiterPhone: null,
      });
    }
  }

  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
