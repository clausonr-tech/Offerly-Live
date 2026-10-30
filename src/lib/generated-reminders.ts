// "You found them, now write to them": the reminder for people a student
// generated with contact search and never emailed.
//
// One reminder per firm, named by the firm - "Email 3 people at PJT Partners" -
// with the people listed under it: "Jane Doe, Sam Lee and Pat Kim". The firm
// is what the work is finished against, and the names are what get an email
// written. (Until 5 October 2026 the title named only the first person, so a
// bell of twenty firms read as twenty people and hid which firm each was.)
// One person left reads "Email Jane Doe at PJT Partners".
// It fires three days after they were found and once more at seven, then
// stops. Clicking it opens the firm's Discovery page, where each of them has a
// "Draft email" button.
//
// The job it files under the bell is an "outreach" job watching the firm, so
// it counts "1 of 3 emailed" and closes itself once everyone there has been
// written to - the same rule, and the same "written to", as the opening-day
// outreach jobs (lib/notifications, outreachProgressBySubject).
//
// The rule is pure (unreachedByFirm), so it can be tested without a database.

import "server-only";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "@/db/client";
import { contacts, firms, userTopFirms } from "@/db/schema";
import { firmResolver } from "@/lib/firm-name";

const DAY = 86_400_000;

/** Days after being found before the first reminder, and before the last. */
export const REMIND_AFTER_DAYS = 3;
export const REMIND_AGAIN_DAYS = 7;

export type ContactRow = {
  id: string;
  name: string;
  firm: string | null;
  /** Set only on someone contact search found. */
  enrichedAt: Date | null;
  relationshipStatus: string;
};

export type UnreachedFirm = {
  /** The firm as the outreach jobs key it - what the bell's progress watches. */
  firmKey: string;
  firmName: string;
  /** The person the reminder names: the first one found and still not written to. */
  lead: { contactId: string; name: string };
  /** Everyone else at the firm not written to yet, found here or not. */
  others: number;
  /**
   * Everyone at the firm not written to yet, by name: the lead first, then
   * the rest found with contact search (oldest first), then anyone saved by
   * hand. One entry per person - `others + 1` of them.
   */
  people: string[];
  /** Days since the lead was found. */
  days: number;
  /** 1 from three days, 2 from seven. The reminder fires once per stage. */
  stage: 1 | 2;
};

/**
 * Firms with someone the student generated at least three days ago and has
 * not written to, oldest first.
 *
 * People, not rows, as the outreach count does: the same name saved twice is
 * one person, written to if either copy has been.
 */
export function unreachedByFirm(
  rows: readonly ContactRow[],
  resolveFirm: (raw: string) => string,
  now: Date,
): UnreachedFirm[] {
  const byFirm = new Map<string, { name: string; people: Map<string, boolean>; shown: Map<string, { name: string; found: boolean }>; found: ContactRow[] }>();
  for (const row of rows) {
    const firm = row.firm?.trim();
    if (!firm) continue;
    const key = resolveFirm(firm);
    if (!key) continue;
    const entry = byFirm.get(key) ?? { name: firm, people: new Map<string, boolean>(), shown: new Map<string, { name: string; found: boolean }>(), found: [] };
    const person = row.name.trim().toLowerCase();
    entry.people.set(person, (entry.people.get(person) ?? false) || row.relationshipStatus !== "not_contacted");
    // The name as first saved, for display - the first search-found copy if
    // there is one, since contact search writes it as their profile has it.
    const prior = entry.shown.get(person);
    if (!prior || (!prior.found && row.enrichedAt)) entry.shown.set(person, { name: row.name.trim(), found: !!row.enrichedAt });
    if (row.enrichedAt) entry.found.push(row);
    byFirm.set(key, entry);
  }

  const out: UnreachedFirm[] = [];
  for (const [firmKey, entry] of byFirm) {
    const waiting = entry.found
      .filter((r) => !entry.people.get(r.name.trim().toLowerCase()))
      .filter((r) => now.getTime() - r.enrichedAt!.getTime() >= REMIND_AFTER_DAYS * DAY)
      .sort((a, b) => a.enrichedAt!.getTime() - b.enrichedAt!.getTime() || a.name.localeCompare(b.name));
    const lead = waiting[0];
    if (!lead) continue;
    const days = Math.floor((now.getTime() - lead.enrichedAt!.getTime()) / DAY);
    const unreached = [...entry.people.values()].filter((reached) => !reached).length;
    const order = [
      ...waiting.map((r) => r.name.trim().toLowerCase()),
      ...entry.found.filter((r) => !entry.people.get(r.name.trim().toLowerCase())).sort((a, b) => a.enrichedAt!.getTime() - b.enrichedAt!.getTime()).map((r) => r.name.trim().toLowerCase()),
      ...[...entry.people.entries()].filter(([, reached]) => !reached).map(([p]) => p).sort(),
    ];
    // The lead as the lead's own row spells it, so the list and the lead agree.
    const leadKey = lead.name.trim().toLowerCase();
    const people = [lead.name.trim(), ...[...new Set(order)].filter((p) => p !== leadKey).map((p) => entry.shown.get(p)?.name ?? p)];
    out.push({
      firmKey,
      firmName: entry.name,
      lead: { contactId: lead.id, name: lead.name.trim() },
      others: Math.max(0, unreached - 1),
      people,
      days,
      stage: days >= REMIND_AGAIN_DAYS ? 2 : 1,
    });
  }
  return out.sort((a, b) => b.days - a.days || a.firmName.localeCompare(b.firmName));
}

/** "Email 3 people at PJT Partners", or "Email Jane Doe at PJT Partners" for one. */
export function generatedTitle(f: Pick<UnreachedFirm, "firmName" | "people">): string {
  return f.people.length === 1 ? `Email ${f.people[0]} at ${f.firmName}` : `Email ${f.people.length} people at ${f.firmName}`;
}

/** How many names a reminder lists before "and N more". */
export const NAMES_SHOWN = 4;

/** "Jane Doe, Sam Lee and Pat Kim", or "Jane Doe, Sam Lee, Pat Kim, Al Roe and 3 more". */
export function peopleLine(people: readonly string[]): string {
  if (people.length <= 1) return people[0] ?? "";
  if (people.length <= NAMES_SHOWN) return `${people.slice(0, -1).join(", ")} and ${people[people.length - 1]}`;
  return `${people.slice(0, NAMES_SHOWN).join(", ")} and ${people.length - NAMES_SHOWN} more`;
}

/** The names, or for one person when they were found: "You found them 4 days ago". */
export function generatedDetail(f: Pick<UnreachedFirm, "people" | "days">): string {
  return f.people.length === 1 ? `You found them ${f.days} days ago` : peopleLine(f.people);
}

/** The bell job's key: one per firm, so the second firing bumps the first. */
export function generatedNotificationKey(firmKey: string): string {
  return `generated:${firmKey}`;
}

/** The bubble's key: one per stage, so each stage speaks once. */
export function generatedFlashKey(f: UnreachedFirm): string {
  return `generated:${f.firmKey}:s${f.stage}`;
}

/** Where the reminder goes: the firm's page, with a Draft email button per person. */
export type ReminderFirm = UnreachedFirm & { href: string };

export async function getUnreachedGenerated(userId: string, now: Date = new Date()): Promise<ReminderFirm[]> {
  const db = await getDb();
  const rows = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: { id: true, name: true, firm: true, enrichedAt: true, relationshipStatus: true },
  });
  if (!rows.some((r) => r.enrichedAt)) return [];

  // Their firms resolve through their own list, as the outreach count does,
  // so "CVP" and "Centerview Partners" are one firm here too.
  const top = await db
    .select({ name: firms.name, aliases: firms.aliases, slug: firms.slug })
    .from(userTopFirms)
    .innerJoin(firms, eq(firms.id, userTopFirms.firmId))
    .where(eq(userTopFirms.userId, userId));
  const resolveFirm = firmResolver(top.map((t) => ({ name: t.name, aliases: t.aliases ?? [] })));

  const found = unreachedByFirm(rows, resolveFirm, now);
  if (found.length === 0) return [];

  // Contact search saves the firm's own name, so an exact match finds the
  // page for firms off their list too.
  const slugByKey = new Map(top.map((t) => [resolveFirm(t.name), t.slug]));
  const missing = found.filter((f) => !slugByKey.has(f.firmKey)).map((f) => f.firmName);
  if (missing.length > 0) {
    const named = await db
      .select({ name: firms.name, slug: firms.slug })
      .from(firms)
      .where(and(inArray(firms.name, missing), isNotNull(firms.slug)));
    for (const n of named) slugByKey.set(resolveFirm(n.name), n.slug);
  }

  return found.map((f) => {
    const slug = slugByKey.get(f.firmKey);
    return {
      ...f,
      href: slug ? `/discovery/firm/${slug}` : `/contacts?q=${encodeURIComponent(f.firmName)}`,
    };
  });
}
