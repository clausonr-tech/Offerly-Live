import Papa from "papaparse";

export function normalizeDate(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function findHeader(headers: string[], patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = headers.find((h) => pattern.test(h.trim().toLowerCase()));
    if (match) return match;
  }
  return undefined;
}

export type ParsedContactRow = {
  name: string;
  firm: string;
  role: string;
  email: string;
  linkedinUrl: string;
  school: string;
  notes: string;
  lastContactDate: string;
};

// Detects common LinkedIn export headers ("First Name", "Last Name", "Company",
// "Position", "Connected On", "URL", "Email Address") as well as generic
// spreadsheet headers, and maps a row of raw CSV values to our contact fields.
export function mapContactRow(row: Record<string, string>, headers: string[]): ParsedContactRow | null {
  const firstNameHeader = findHeader(headers, [/^first ?name$/]);
  const lastNameHeader = findHeader(headers, [/^last ?name$/]);
  const nameHeader = findHeader(headers, [/^(full ?)?name$/, /^contact ?name$/]);

  let name = "";
  if (nameHeader) {
    name = row[nameHeader]?.trim() ?? "";
  } else if (firstNameHeader || lastNameHeader) {
    name = [row[firstNameHeader ?? ""], row[lastNameHeader ?? ""]]
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  if (!name) return null;

  const firmHeader = findHeader(headers, [/^(company|firm|organization|employer)$/]);
  const roleHeader = findHeader(headers, [/^(position|title|job ?title|role)$/]);
  const emailHeader = findHeader(headers, [/email/]);
  const urlHeader = findHeader(headers, [/^url$/, /linkedin/, /profile/]);
  const schoolHeader = findHeader(headers, [/^(school|university|college)$/]);
  const notesHeader = findHeader(headers, [/^notes?$/]);
  const dateHeader = findHeader(headers, [/connected ?on/, /^(last )?contact ?date$/, /^date$/]);

  return {
    name,
    firm: firmHeader ? (row[firmHeader]?.trim() ?? "") : "",
    role: roleHeader ? (row[roleHeader]?.trim() ?? "") : "",
    email: emailHeader ? (row[emailHeader]?.trim() ?? "") : "",
    linkedinUrl: urlHeader ? (row[urlHeader]?.trim() ?? "") : "",
    school: schoolHeader ? (row[schoolHeader]?.trim() ?? "") : "",
    notes: notesHeader ? (row[notesHeader]?.trim() ?? "") : "",
    lastContactDate: dateHeader ? (row[dateHeader]?.trim() ?? "") : "",
  };
}

export type ParsedApplicationRow = {
  firm: string;
  role: string;
  status: string;
  notes: string;
  appliedDate: string;
  deadlineDate: string;
};

const STATUS_ALIASES: Record<string, string> = {
  "not started": "not_started",
  "in progress": "in_progress",
  applied: "submitted",
  submitted: "submitted",
  interviewing: "interviewing",
  interview: "interviewing",
  offer: "offer",
  rejected: "rejected",
  declined: "rejected",
};

export function mapApplicationRow(
  row: Record<string, string>,
  headers: string[],
): ParsedApplicationRow | null {
  const firmHeader = findHeader(headers, [/^(company|firm|organization|employer)$/]);
  const roleHeader = findHeader(headers, [/^(position|title|job ?title|role)$/]);
  if (!firmHeader && !roleHeader) return null;

  const firm = firmHeader ? (row[firmHeader]?.trim() ?? "") : "";
  const role = roleHeader ? (row[roleHeader]?.trim() ?? "") : "";
  if (!firm && !role) return null;

  const statusHeader = findHeader(headers, [/^status$/]);
  const notesHeader = findHeader(headers, [/^notes?$/]);
  const appliedHeader = findHeader(headers, [/applied ?date/, /^date ?applied$/]);
  const deadlineHeader = findHeader(headers, [/deadline/, /due ?date/]);

  const rawStatus = statusHeader ? (row[statusHeader]?.trim().toLowerCase() ?? "") : "";

  return {
    firm: firm || "Unknown firm",
    role: role || "Unknown role",
    status: STATUS_ALIASES[rawStatus] ?? "not_started",
    notes: notesHeader ? (row[notesHeader]?.trim() ?? "") : "",
    appliedDate: appliedHeader ? (row[appliedHeader]?.trim() ?? "") : "",
    deadlineDate: deadlineHeader ? (row[deadlineHeader]?.trim() ?? "") : "",
  };
}

/**
 * Parse CSV text into mapped rows, counting the ones that could not be mapped.
 *
 * Lifted out of the two import forms, which carried the same twenty-five lines
 * of FileReader/Papa/header-check/map-loop with only the mapper differing -
 * so a fix to the header handling had to be made twice and, being invisible,
 * would eventually be made once.
 *
 * Pure: takes text rather than a File, so it can be tested without a DOM.
 * The caller still owns reading the file and rendering the outcome.
 */
export type CsvParseResult<T> =
  | { ok: true; rows: T[]; skipped: number }
  | { ok: false; error: string };

export function parseCsvText<T>(
  text: string,
  mapRow: (row: Record<string, string>, headers: string[]) => T | null,
): CsvParseResult<T> {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  const headers = result.meta.fields ?? [];
  if (headers.length === 0) {
    return { ok: false, error: "Couldn't find a header row in this file." };
  }

  const rows: T[] = [];
  let skipped = 0;
  for (const row of result.data) {
    const mapped = mapRow(row, headers);
    if (mapped) rows.push(mapped);
    else skipped++;
  }
  return { ok: true, rows, skipped };
}
