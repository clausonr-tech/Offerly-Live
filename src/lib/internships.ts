/**
 * The internships list from the profile's About you form - a JSON array the
 * client builds, checked again here because a form post is trivial to forge.
 * Pure, so it is tested without a request.
 */
/** The most internships the profile keeps. */
export const MAX_INTERNSHIPS = 12;

/**
 * The internships list from the About you form: a JSON array the client
 * builds. Everything in it is re-checked here - lengths, types, a firm id
 * shaped like one - because a form post is trivial to forge.
 */
export function parseInternships(
  raw: FormDataEntryValue | null,
): { list: { firm: string; firmId: string | null; role: string; start: string | null; end: string | null; current: boolean }[] } | { error: string } {
  if (raw == null || raw === "") return { list: [] };
  let data: unknown;
  try {
    data = JSON.parse(String(raw));
  } catch {
    return { error: "Couldn't read your internships. Try again." };
  }
  if (!Array.isArray(data)) return { error: "Couldn't read your internships. Try again." };
  if (data.length > MAX_INTERNSHIPS) return { error: `Keep it to ${MAX_INTERNSHIPS} internships.` };
  const list = [];
  for (const item of data) {
    const o = (item ?? {}) as Record<string, unknown>;
    const firm = String(o.firm ?? "").trim().slice(0, 100);
    const role = String(o.role ?? "").trim().slice(0, 100);
    const firmId = typeof o.firmId === "string" && /^[0-9a-f-]{36}$/i.test(o.firmId) ? o.firmId : null;
    if (!firm) return { error: "Each internship needs a firm." };
    const start = monthOrNull(o.start);
    // Ongoing is the student's tick, and an ongoing internship has no end.
    const current = o.current === true;
    const end = current ? null : monthOrNull(o.end);
    // Dates are required: a start always, and an end unless it's ongoing.
    if (!start) return { error: `Pick a start month for ${firm}.` };
    if (!end && !current) return { error: `Pick an end month for ${firm}, or tick "I'm still here".` };
    if (start && end && end < start) return { error: `${firm}: the end is before the start.` };
    list.push({ firm, firmId, role, start, end, current });
  }
  return { list };
}


/** "2026-05" -> itself, anything else -> null. Years kept to a sane range. */
function monthOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!m) return null;
  const year = Number(m[1]);
  return year >= 1980 && year <= 2100 ? v : null;
}

/** "2026-05" -> "May 2026". */
function formatMonth(v: string | null): string | null {
  if (!v) return null;
  const [y, m] = v.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** "May 2026 - Now", "Jun 2025 - Aug 2025", or null when there are no dates. */
export function internshipDates(i: { start: string | null; end: string | null; current: boolean }): string | null {
  const start = formatMonth(i.start);
  if (!start) return i.current ? "Now" : null;
  return `${start} \u2013 ${i.current ? "Now" : (formatMonth(i.end) ?? "")}`.trim();
}
