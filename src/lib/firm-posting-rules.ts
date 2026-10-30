// What a firm may post, and how the portal's forms turn into rows. Pure: no
// database, so every rule here has a test (scripts/test/firm-posting.test.ts).
//
// A firm can say whatever it wants about a role - the description, the
// requirements and any number of its own "label: value" details are free -
// but a few fields are required because matching cannot work without them:
// which summer, which sectors, who can apply and how. A posting missing those
// would be stored and then shown to nobody.

import type { FirmProgramCategory } from "@/lib/firm-metadata";

export const POSTING_CATEGORIES: FirmProgramCategory[] = [
  "investment_banking",
  "private_equity",
  "venture_capital",
  "private_credit",
  "real_estate",
  "hedge_fund",
  "sales_trading",
  "asset_wealth_management",
  "commercial_banking",
  "insurance",
  "fintech",
  "market_infrastructure",
  "consulting",
  "other_finance",
];

export const EVENT_KINDS = ["info_session", "speaker_event", "coffee_chat", "networking", "other"] as const;
export type FirmEventKind = (typeof EVENT_KINDS)[number];
export const EVENT_KIND_CHOICES: Record<FirmEventKind, string> = {
  info_session: "Info session",
  speaker_event: "Speaker event",
  coffee_chat: "Coffee chat",
  networking: "Networking",
  other: "Other event",
};

/** An event's type as shown anywhere: the firm's own words for "Other event", else the standard label. */
export function eventKindLabel(kind: string, kindLabel?: string | null): string {
  if (kind === "other" && kindLabel?.trim()) return kindLabel.trim();
  return EVENT_KIND_CHOICES[kind as FirmEventKind] ?? "Event";
}

export const EVENT_FORMATS = ["in_person", "virtual", "hybrid"] as const;
export type EventFormat = (typeof EVENT_FORMATS)[number];
export const EVENT_FORMAT_LABELS: Record<EventFormat, string> = {
  in_person: "In person",
  virtual: "Virtual",
  hybrid: "In person and virtual",
};

export const LIMITS = {
  title: 150,
  location: 150,
  description: 8000,
  descriptionMin: 40,
  requirements: 4000,
  extraFields: 12,
  extraLabel: 60,
  extraValue: 1000,
  name: 100,
  eventDescription: 4000,
  eventSchools: 25,
  kindLabel: 40,
};

export type ExtraField = { label: string; value: string };

export type PostingInput = {
  roleTitle: string;
  categories: FirmProgramCategory[];
  programYear: number;
  eligibleGradYears: number[];
  location: string | null;
  deadlineStatus: "confirmed" | "rolling" | "tbd";
  deadlineDate: Date | null;
  opensAt: Date | null;
  applicationUrl: string | null;
  recruiterName: string | null;
  recruiterTitle: string | null;
  recruiterEmail: string | null;
  description: string;
  requirements: string | null;
  extraFields: ExtraField[];
};

export type EventInput = {
  kind: FirmEventKind;
  /** Required when kind is "other": what kind of event it is, in the firm's words. */
  kindLabel?: string | null;
  title: string;
  schoolIds: string[];
  startsAt: Date;
  endsAt: Date | null;
  registrationDeadline: Date | null;
  format: EventFormat;
  location: string | null;
  rsvpUrl: string | null;
  description: string;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const str = (v: FormDataEntryValue | null | undefined) => (typeof v === "string" ? v.trim() : "");
const opt = (v: FormDataEntryValue | null | undefined) => str(v) || null;

/** An http(s) URL, or null. Anything else - javascript:, mailto:, a bare word - is refused. */
export function cleanUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A `datetime-local` value ("2026-10-14T18:30") in the poster's own time zone.
 * `offsetMinutes` is the browser's getTimezoneOffset() for that moment, sent
 * with the form, so an event typed as 6:30pm in New York is stored as 6:30pm
 * in New York whatever time zone the server runs in.
 */
export function parseLocalDateTime(value: string, offsetMinutes: number, timeIfDateOnly = "12:00"): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [dh, dm] = timeIfDateOnly.split(":");
  const [, y, mo, d, h = dh, mi = dm] = m;
  const [year, month, day, hour, minute] = [+y, +mo, +d, +h, +mi];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  // Date.UTC rolls an impossible day over - 31 February becomes 3 March - so
  // a date that does not survive the round trip never existed.
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return new Date(utc + clampOffset(offsetMinutes) * 60 * 1000);
}

/**
 * The browser's getTimezoneOffset(), trusted only within the range real time
 * zones span (UTC-12 to UTC+14). It arrives in a form field, so anything
 * outside that - or not a number at all - is treated as UTC rather than
 * allowed to move a date by months.
 */
function clampOffset(offsetMinutes: number): number {
  if (!Number.isFinite(offsetMinutes)) return 0;
  return offsetMinutes >= -14 * 60 && offsetMinutes <= 12 * 60 ? offsetMinutes : 0;
}

function readExtraFields(form: FormData): Parsed<ExtraField[]> {
  const labels = form.getAll("extraLabel").map(str);
  const values = form.getAll("extraValue").map(str);
  const out: ExtraField[] = [];
  for (let i = 0; i < Math.max(labels.length, values.length); i++) {
    const label = labels[i] ?? "";
    const value = values[i] ?? "";
    if (!label && !value) continue;
    if (!label || !value) return { ok: false, error: "Each extra detail needs both a label and a value." };
    if (label.length > LIMITS.extraLabel) return { ok: false, error: `Detail labels can be up to ${LIMITS.extraLabel} characters.` };
    if (value.length > LIMITS.extraValue) return { ok: false, error: `Each detail can be up to ${LIMITS.extraValue} characters.` };
    out.push({ label, value });
  }
  if (out.length > LIMITS.extraFields) return { ok: false, error: `You can add up to ${LIMITS.extraFields} extra details.` };
  return { ok: true, value: out };
}

/** The summers a firm may post for: this one through four years out. */
export function programYearChoices(now: Date = new Date()): number[] {
  const y = now.getUTCFullYear();
  return [y, y + 1, y + 2, y + 3, y + 4];
}

export function parsePostingForm(form: FormData, now: Date = new Date()): Parsed<PostingInput> {
  const roleTitle = str(form.get("roleTitle"));
  if (!roleTitle) return { ok: false, error: "Add the role title." };
  if (roleTitle.length > LIMITS.title) return { ok: false, error: `The role title can be up to ${LIMITS.title} characters.` };

  const categories = [...new Set(form.getAll("categories").map(str))].filter((c): c is FirmProgramCategory =>
    POSTING_CATEGORIES.includes(c as FirmProgramCategory),
  );
  if (categories.length === 0) return { ok: false, error: "Pick at least one sector, so the right students see it." };

  const programYear = Number(str(form.get("programYear")));
  if (!programYearChoices(now).includes(programYear)) return { ok: false, error: "Pick which summer the internship runs." };

  const eligibleGradYears = [...new Set(form.getAll("eligibleGradYears").map((v) => Number(str(v))))]
    .filter((y) => Number.isInteger(y) && y >= programYear - 1 && y <= programYear + 4)
    .sort();

  const location = opt(form.get("location"));
  if (location && location.length > LIMITS.location) return { ok: false, error: `Location can be up to ${LIMITS.location} characters.` };

  const offset = Number(str(form.get("tzOffset")) || "0");
  const mode = str(form.get("deadlineMode"));
  let deadlineStatus: PostingInput["deadlineStatus"] = "tbd";
  let deadlineDate: Date | null = null;
  if (mode === "date") {
    // A deadline given as a day means the end of that day, the poster's time.
    deadlineDate = parseLocalDateTime(str(form.get("deadlineDate")), offset, "23:59");
    if (!deadlineDate) return { ok: false, error: "Add the application deadline, or choose rolling." };
    deadlineStatus = "confirmed";
  } else if (mode === "rolling") {
    deadlineStatus = "rolling";
  }
  const opensRaw = str(form.get("opensDate"));
  const opensAt = opensRaw ? parseLocalDateTime(opensRaw, offset) : null;
  if (opensRaw && !opensAt) return { ok: false, error: "The opening date isn't a valid date." };

  const urlRaw = str(form.get("applicationUrl"));
  const applicationUrl = urlRaw ? cleanUrl(urlRaw) : null;
  if (urlRaw && !applicationUrl) return { ok: false, error: "The application link must start with https://." };
  const recruiterEmail = opt(form.get("recruiterEmail"));
  if (recruiterEmail && !EMAIL_RE.test(recruiterEmail)) return { ok: false, error: "The contact email isn't a valid address." };
  if (!applicationUrl && !recruiterEmail) {
    return { ok: false, error: "Add an application link or a contact email, so students can apply." };
  }
  const recruiterName = opt(form.get("recruiterName"));
  const recruiterTitle = opt(form.get("recruiterTitle"));
  if ((recruiterName?.length ?? 0) > LIMITS.name || (recruiterTitle?.length ?? 0) > LIMITS.name) {
    return { ok: false, error: `Contact name and title can be up to ${LIMITS.name} characters.` };
  }

  const description = str(form.get("description"));
  if (description.length < LIMITS.descriptionMin) {
    return { ok: false, error: `Describe the role in at least ${LIMITS.descriptionMin} characters.` };
  }
  if (description.length > LIMITS.description) return { ok: false, error: `The description can be up to ${LIMITS.description} characters.` };
  const requirements = opt(form.get("requirements"));
  if (requirements && requirements.length > LIMITS.requirements) {
    return { ok: false, error: `Requirements can be up to ${LIMITS.requirements} characters.` };
  }

  const extra = readExtraFields(form);
  if (!extra.ok) return extra;

  return {
    ok: true,
    value: {
      roleTitle,
      categories,
      programYear,
      eligibleGradYears,
      location,
      deadlineStatus,
      deadlineDate,
      opensAt,
      applicationUrl,
      recruiterName,
      recruiterTitle,
      recruiterEmail,
      description,
      requirements,
      extraFields: extra.value,
    },
  };
}

/**
 * What students read: the firm's description, then its own extra details as
 * "Label: value" lines. The extra details are kept structured on the row too
 * (extraFields), so the portal can edit them; this is only the reading copy.
 */
export function composeDescription(description: string, extra: ExtraField[]): string {
  const body = description.trim();
  if (extra.length === 0) return body;
  return `${body}\n\nAdditional details\n${extra.map((f) => `${f.label}: ${f.value}`).join("\n")}`;
}

/** Every piece of text in a posting, labelled, for the language check. */
export function postingLanguageFields(p: PostingInput): [string, string | null][] {
  return [
    ["Role title", p.roleTitle],
    ["Location", p.location],
    ["Contact name", p.recruiterName],
    ["Contact title", p.recruiterTitle],
    ["Description", p.description],
    ["Requirements", p.requirements],
    ...p.extraFields.flatMap((f): [string, string][] => [
      ["Detail label", f.label],
      [f.label, f.value],
    ]),
  ];
}

export function parseEventForm(
  form: FormData,
  now: Date = new Date(),
  /** Editing an event that already happened - to fix its description, say - must not be refused for being in the past. */
  opts: { editing?: boolean } = {},
): Parsed<EventInput> {
  const kind = str(form.get("kind")) as FirmEventKind;
  if (!EVENT_KINDS.includes(kind)) return { ok: false, error: "Pick what kind of event this is." };
  // "Other event" asks what kind; that answer is the type students see.
  const kindLabel = kind === "other" ? str(form.get("kindLabel")) || null : null;
  if (kind === "other" && !kindLabel) return { ok: false, error: "Say what kind of event this is." };
  if (kindLabel && kindLabel.length > LIMITS.kindLabel) {
    return { ok: false, error: `The kind of event can be up to ${LIMITS.kindLabel} characters.` };
  }

  const title = str(form.get("title"));
  if (!title) return { ok: false, error: "Add a title." };
  if (title.length > LIMITS.title) return { ok: false, error: `The title can be up to ${LIMITS.title} characters.` };

  const openToAll = str(form.get("openToAll")) === "on";
  const schoolIds = openToAll
    ? []
    : [...new Set(form.getAll("schoolIds").map(str).filter((s) => /^[0-9a-f-]{36}$/i.test(s)))];
  if (!openToAll && schoolIds.length === 0) {
    return { ok: false, error: "Pick the schools this event is for, or open it to students anywhere." };
  }
  if (schoolIds.length > LIMITS.eventSchools) return { ok: false, error: `Pick up to ${LIMITS.eventSchools} schools.` };

  const offset = Number(str(form.get("tzOffset")) || "0");
  const startsAt = parseLocalDateTime(str(form.get("startsAt")), offset);
  if (!startsAt) return { ok: false, error: "Add when the event starts." };
  if (!opts.editing && startsAt.getTime() < now.getTime() - 60 * 60 * 1000) {
    return { ok: false, error: "The start time is in the past." };
  }
  const endsRaw = str(form.get("endsAt"));
  const endsAt = endsRaw ? parseLocalDateTime(endsRaw, offset) : null;
  if (endsRaw && !endsAt) return { ok: false, error: "The end time isn't a valid time." };
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) return { ok: false, error: "The event has to end after it starts." };
  const regRaw = str(form.get("registrationDeadline"));
  const registrationDeadline = regRaw ? parseLocalDateTime(regRaw, offset) : null;
  if (regRaw && !registrationDeadline) return { ok: false, error: "The registration deadline isn't a valid date." };

  const format = str(form.get("format")) as EventFormat;
  if (!EVENT_FORMATS.includes(format)) return { ok: false, error: "Pick in person, virtual, or both." };
  const location = opt(form.get("location"));
  if (format !== "virtual" && !location) return { ok: false, error: "Add where the event is." };
  if (location && location.length > LIMITS.location) return { ok: false, error: `Location can be up to ${LIMITS.location} characters.` };

  const rsvpRaw = str(form.get("rsvpUrl"));
  const rsvpUrl = rsvpRaw ? cleanUrl(rsvpRaw) : null;
  if (rsvpRaw && !rsvpUrl) return { ok: false, error: "The RSVP link must start with https://." };

  const description = str(form.get("description"));
  if (!description) return { ok: false, error: "Add a short description." };
  if (description.length > LIMITS.eventDescription) {
    return { ok: false, error: `The description can be up to ${LIMITS.eventDescription} characters.` };
  }

  return {
    ok: true,
    value: { kind, kindLabel, title, schoolIds, startsAt, endsAt, registrationDeadline, format, location, rsvpUrl, description },
  };
}

export function eventLanguageFields(e: EventInput): [string, string | null][] {
  return [
    // Only when the firm typed one ("Other event"); the standard kinds are ours.
    ...(e.kindLabel ? ([["Kind of event", e.kindLabel]] as [string, string][]) : []),
    ["Title", e.title],
    ["Location", e.location],
    ["Description", e.description],
  ];
}

/** The firm's own description back out of descriptionFull, for the edit form. */
export function originalDescription(full: string, extra: ExtraField[]): string {
  if (extra.length === 0) return full;
  const suffix = composeDescription("", extra);
  return full.endsWith(suffix) ? full.slice(0, -suffix.length) : full;
}
