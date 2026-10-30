// Loads when internships were released in past cycles, so expected roles open
// on the day they really did last year rather than the day the crawler first
// noticed them (lib/expected-postings).
//
//   npm run history:import -- path/to/releases.csv            replace
//   npm run history:import -- path/to/releases.csv --append   add to what is there
//
// One row per internship per cycle. Headers are matched loosely (case,
// spaces and underscores ignored):
//
//   firm          the firm's name as Offerly lists it       required
//   role          the role title as it was posted           required
//   location      city, when the firm posts per city        optional
//   program_year  the summer it ran, e.g. 2027              required (or a year in the role title)
//   released_on   the day it opened                         required
//   due_on        the day applications closed               optional
//
// Dates may be 2026-08-03, 8/3/2026 or "Aug 3, 2026". Rows that cannot be
// read are skipped and listed, never guessed at. Writes
// src/lib/historical-releases.json, which is committed with the code.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Papa from "papaparse";

import type { HistoricalRelease } from "../src/lib/expected-postings";

const OUT = path.join(process.cwd(), "src/lib/historical-releases.json");

const HEADERS: Record<string, keyof HistoricalRelease> = {
  firm: "firmName",
  firmname: "firmName",
  company: "firmName",
  role: "roleTitle",
  roletitle: "roleTitle",
  title: "roleTitle",
  position: "roleTitle",
  location: "location",
  city: "location",
  programyear: "programYear",
  year: "programYear",
  cycle: "programYear",
  releasedon: "releasedOn",
  released: "releasedOn",
  releasedate: "releasedOn",
  opened: "releasedOn",
  openedon: "releasedOn",
  opensat: "releasedOn",
  posted: "releasedOn",
  postedon: "releasedOn",
  dueon: "dueOn",
  due: "dueOn",
  deadline: "dueOn",
  closedon: "dueOn",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A date in any of the accepted shapes, as YYYY-MM-DD, or null. */
export function readDay(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let hit: RegExpMatchArray | null;
  if ((hit = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [y, m, d] = [+hit[1], +hit[2], +hit[3]];
  else if ((hit = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) [m, d, y] = [+hit[1], +hit[2], +hit[3] < 100 ? 2000 + +hit[3] : +hit[3]];
  else if ((hit = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    m = MONTHS.indexOf(hit[1].toLowerCase()) + 1;
    [d, y] = [+hit[2], +hit[3]];
  } else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (!m || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || y < 2015 || y > 2040) return null;
  return date.toISOString().slice(0, 10);
}

export function readRows(csv: string): { rows: HistoricalRelease[]; skipped: { line: number; why: string }[] } {
  const parsed = Papa.parse<Record<string, string>>(csv.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.toLowerCase().replace(/[^a-z]/g, ""),
  });
  const rows: HistoricalRelease[] = [];
  const skipped: { line: number; why: string }[] = [];
  parsed.data.forEach((raw, i) => {
    const line = i + 2;
    const get = (field: keyof HistoricalRelease) =>
      Object.entries(raw).find(([h]) => HEADERS[h] === field)?.[1]?.trim() ?? "";
    const firmName = get("firmName");
    const roleTitle = get("roleTitle");
    if (!firmName) return skipped.push({ line, why: "no firm" });
    if (!roleTitle) return skipped.push({ line, why: "no role" });
    const releasedOn = readDay(get("releasedOn"));
    if (!releasedOn) return skipped.push({ line, why: `released date "${get("releasedOn")}" not readable` });
    const dueRaw = get("dueOn");
    const dueOn = readDay(dueRaw);
    if (dueRaw && !dueOn) return skipped.push({ line, why: `due date "${dueRaw}" not readable` });
    const yearText = get("programYear") || roleTitle.match(/\b(20[2-4]\d)\b/)?.[1] || "";
    const programYear = Number(yearText);
    if (!Number.isInteger(programYear) || programYear < 2015 || programYear > 2040) {
      return skipped.push({ line, why: "no program year (column or a year in the role)" });
    }
    if (dueOn && dueOn < releasedOn) return skipped.push({ line, why: "due before it was released" });
    rows.push({ firmName, roleTitle, location: get("location") || null, programYear, releasedOn, dueOn });
  });
  return { rows, skipped };
}

function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: npm run history:import -- path/to/releases.csv [--append]");
    process.exit(1);
  }
  const { rows, skipped } = readRows(readFileSync(file, "utf8"));
  const before: HistoricalRelease[] = process.argv.includes("--append") ? JSON.parse(readFileSync(OUT, "utf8")) : [];
  const key = (r: HistoricalRelease) => [r.firmName, r.roleTitle, r.location ?? "", r.programYear].join("|").toLowerCase();
  const merged = new Map(before.map((r) => [key(r), r]));
  for (const r of rows) merged.set(key(r), r);
  const out = [...merged.values()].sort(
    (a, b) => a.firmName.localeCompare(b.firmName) || a.programYear - b.programYear || a.roleTitle.localeCompare(b.roleTitle),
  );
  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${rows.length} rows read, ${skipped.length} skipped; ${out.length} in ${path.relative(process.cwd(), OUT)}.`);
  for (const s of skipped.slice(0, 50)) console.log(`  line ${s.line}: ${s.why}`);
  if (skipped.length > 50) console.log(`  ...and ${skipped.length - 50} more`);
}

if (process.argv[1]?.endsWith("import-historical-releases.ts")) main();
