// Imports the people database from an Excel or CSV export.
//
//   npx tsx --conditions=react-server scripts/import-people.ts <file.xlsx> [batch-name]
//
// Stop the dev server first - this opens the PGlite directory directly, and
// PGlite allows a single writer.
//
// Column headers are matched loosely (case, spacing and punctuation are
// ignored) against the aliases below, so a spreadsheet written by a human does
// not have to be renamed to import. Anything unrecognised is reported once
// rather than silently dropped, so a column nobody mapped is visible.
import { openScriptDb } from "./_db";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import * as schema from "../src/db/schema";
import { normalizeFirmName } from "../src/lib/network-coverage";

const ALIASES: Record<string, string[]> = {
  name: ["name", "fullname", "person", "contactname"],
  firmName: ["firm", "firmname", "company", "employer", "organization", "organisation"],
  title: ["title", "role", "position", "jobtitle"],
  school: ["school", "university", "college", "alma mater", "almamater"],
  degree: ["degree", "major", "concentration", "fieldofstudy"],
  schoolYears: ["schoolyears", "years", "yearsattended", "classyear", "class"],
  jobHistory: ["jobhistory", "experience", "priorroles", "workhistory", "previous"],
  linkedinUrl: ["linkedin", "linkedinurl", "linkedinprofile", "profile", "profileurl"],
  email: ["email", "emailaddress", "workemail"],
};

const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

function buildHeaderMap(headers: string[]) {
  const map = new Map<string, string>();
  const unmatched: string[] = [];
  for (const h of headers) {
    const k = key(h);
    const field = Object.entries(ALIASES).find(([, names]) => names.includes(k))?.[0];
    if (field) map.set(h, field);
    else unmatched.push(h);
  }
  return { map, unmatched };
}

/** "2018-2022", "Class of 2022", "2022" -> 2022. Null when there is no year. */
function parseGradYear(raw: string | null): number | null {
  if (!raw) return null;
  const years = raw.match(/(19|20)\d{2}/g);
  if (!years?.length) return null;
  // The last four-digit year is the graduation one in every common format.
  const year = Number(years[years.length - 1]);
  return year >= 1950 && year <= 2100 ? year : null;
}

const str = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s && s.toLowerCase() !== "n/a" ? s : null;
};

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: import-people.ts <file.xlsx|file.csv> [batch-name]");
    process.exit(1);
  }
  const batch = process.argv[3] ?? file.split("/").pop() ?? "import";

  const wb = XLSX.read(readFileSync(file));
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  if (rows.length === 0) {
    console.log("No rows in the first sheet.");
    return;
  }

  const { map, unmatched } = buildHeaderMap(Object.keys(rows[0]));
  if (unmatched.length) console.log(`Ignored columns: ${unmatched.join(", ")}`);
  if (![...map.values()].includes("name")) {
    console.error("No name column found. Expected one of: " + ALIASES.name.join(", "));
    process.exit(1);
  }

  const { db } = await openScriptDb();

  // Firms are matched on the normalised name, the same way contacts are, so
  // "Evercore Partners" lands on Evercore rather than creating an orphan.
  const firms = await db.query.firms.findMany({ columns: { id: true, name: true } });
  const firmByKey = new Map(firms.map((f) => [normalizeFirmName(f.name), f.id]));

  // Everything this batch holds today, so rows the new file dropped can be
  // marked delisted rather than deleted - a student may have notes on someone
  // who has since left, and those should survive the person leaving.
  const previous = await db.query.directoryPeople.findMany({
    where: eq(schema.directoryPeople.importBatch, batch),
    columns: { id: true, name: true, firmName: true, delistedAt: true },
  });
  const identity = (name: string, firm: string) =>
    `${name.trim().toLowerCase()}|||${normalizeFirmName(firm)}`;
  const previousByIdentity = new Map(previous.map((r) => [identity(r.name, r.firmName), r]));

  const values: (typeof schema.directoryPeople.$inferInsert)[] = [];
  let skipped = 0;
  let unmatchedFirms = 0;

  for (const row of rows) {
    const get = (field: string): string | null => {
      const header = [...map.entries()].find(([, f]) => f === field)?.[0];
      return header ? str(row[header]) : null;
    };

    const name = get("name");
    const firmName = get("firmName");
    if (!name || !firmName) {
      skipped++;
      continue;
    }

    const firmId = firmByKey.get(normalizeFirmName(firmName)) ?? null;
    if (!firmId) unmatchedFirms++;

    const schoolYears = get("schoolYears");
    values.push({
      firmId,
      firmName,
      name,
      title: get("title"),
      school: get("school"),
      degree: get("degree"),
      schoolYears,
      gradYear: parseGradYear(schoolYears),
      jobHistory: get("jobHistory"),
      linkedinUrl: get("linkedinUrl"),
      email: get("email"),
      importBatch: batch,
    });
  }

  // Replace this batch's rows with the file's, then re-mark the ones that
  // vanished. Delete-then-insert keeps the import simple; the delisting pass
  // below is what preserves the knowledge that someone used to be there.
  const seen = new Set(values.map((v) => identity(v.name, v.firmName)));
  await db.delete(schema.directoryPeople).where(eq(schema.directoryPeople.importBatch, batch));

  // Chunked: one insert of tens of thousands of rows exceeds the parameter
  // limit that both PGlite and Postgres enforce.
  for (let i = 0; i < values.length; i += 500) {
    await db.insert(schema.directoryPeople).values(values.slice(i, i + 500));
  }

  const gone = previous.filter((r) => !seen.has(identity(r.name, r.firmName)));
  if (gone.length) {
    const now = new Date();
    for (let i = 0; i < gone.length; i += 500) {
      await db.insert(schema.directoryPeople).values(
        gone.slice(i, i + 500).map((r) => ({
          firmName: r.firmName,
          name: r.name,
          importBatch: batch,
          // Keep the original delisting date if it was already gone last time.
          delistedAt: r.delistedAt ?? now,
        })),
      );
    }
  }

  console.log(`Imported ${values.length} people as batch "${batch}".`);
  if (gone.length) {
    console.log(`${gone.length} person(s) no longer in the file - marked as delisted, not deleted.`);
  }
  if (skipped) console.log(`Skipped ${skipped} row(s) with no name or no firm.`);
  if (unmatchedFirms) {
    console.log(`${unmatchedFirms} row(s) kept with an unmatched firm name (searchable, no logo).`);
  }
}

// PGlite keeps the event loop alive after the last query, so the process never
// exits on its own and a piped stdout never flushes. Same reason the seed
// scripts next door end with an explicit exit.
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
