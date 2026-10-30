/**
 * Collapses duplicate tracked applications, so the unique index can be applied.
 *
 * `applications` had no constraint on (user_id, firm, role); autoTrackInternships
 * held the invariant up with a read-then-insert, which loses to anything
 * concurrent. Measured on Supabase, 22 September 2026: demo@offerly.test held
 * 41 rows covering 22 distinct pairs, all nineteen duplicates at Evercore.
 *
 * It showed up as the product contradicting itself - Discovery counts a Set of
 * `firm|role` and said "You're tracking 22 roles", /tracking counts rows and
 * said "41 roles across 3 firms" - and as every Evercore role appearing twice,
 * side by side, in the tracking panel.
 *
 * WHICH COPY SURVIVES. Not simply the oldest. A duplicate pair is the same
 * application twice, but the student may have worked on either copy, and the
 * one carrying their work is the one to keep:
 *
 *   1. a status other than the default "not_started" - they moved it along
 *   2. the most linked rows (events, contacts) hanging off it
 *   3. anything typed into it: notes they wrote, an applied date, a
 *      compensation figure
 *   4. oldest createdAt, as the tie-break
 *
 * Losing copies' linked events and contacts are REPARENTED onto the survivor
 * before it is deleted, so nothing a student attached is lost even when the
 * copy it was attached to is the one that goes.
 *
 * Read-only unless you pass --apply:
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/dedupe-tracked-applications.ts
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/dedupe-tracked-applications.ts --apply
 */
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applicationContacts, applications, events, users } from "@/db/schema";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = await getDb();

  const rows = await db
    .select({
      id: applications.id,
      userId: applications.userId,
      firm: applications.firm,
      role: applications.role,
      status: applications.status,
      notes: applications.notes,
      appliedDate: applications.appliedDate,
      compensation: applications.compensation,
      createdAt: applications.createdAt,
      email: users.email,
    })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.userId));

  // How much is hanging off each row, so a copy carrying the student's work is
  // never the one deleted.
  const linkCount = new Map<string, number>();
  const bump = (id: string, n = 1) => linkCount.set(id, (linkCount.get(id) ?? 0) + n);
  for (const e of await db
    .select({ applicationId: events.applicationId })
    .from(events)) {
    if (e.applicationId) bump(e.applicationId);
  }
  for (const c of await db
    .select({ applicationId: applicationContacts.applicationId })
    .from(applicationContacts)) {
    bump(c.applicationId);
  }

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.userId}|${r.firm}|${r.role}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  /** Higher is better. See "WHICH COPY SURVIVES" above. */
  const worth = (r: (typeof rows)[number]) => [
    r.status && r.status !== "not_started" ? 1 : 0,
    linkCount.get(r.id) ?? 0,
    [r.notes, r.appliedDate, r.compensation].filter((v) => v != null && v !== "").length,
    -r.createdAt.getTime(),
  ];

  const survivors: { keep: string; drop: string[]; who: string; what: string }[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => {
      const [x, y] = [worth(a), worth(b)];
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
      return 0;
    });
    survivors.push({
      keep: ranked[0].id,
      drop: ranked.slice(1).map((r) => r.id),
      who: ranked[0].email,
      what: `${ranked[0].firm} — ${ranked[0].role}`,
    });
  }

  const dropped = survivors.flatMap((s) => s.drop);
  console.log(`\nduplicate groups: ${survivors.length}`);
  console.log(`rows to delete:   ${dropped.length}`);
  const byUser = new Map<string, number>();
  for (const s of survivors) byUser.set(s.who, (byUser.get(s.who) ?? 0) + s.drop.length);
  for (const [email, n] of byUser) console.log(`   ${email}: ${n}`);
  for (const s of survivors.slice(0, 3)) console.log(`   e.g. ${s.what}`);

  const reparenting = dropped.reduce((n, id) => n + (linkCount.get(id) ?? 0), 0);
  console.log(`linked events/contacts to move onto the survivor: ${reparenting}`);

  if (!APPLY) {
    console.log("\nDRY RUN - nothing changed. Re-run with --apply.");
    return;
  }
  if (dropped.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  for (const s of survivors) {
    if (!s.drop.length) continue;
    // Reparent first, delete second. The other order loses the links to the
    // events/application_contacts cascade.
    await db
      .update(events)
      .set({ applicationId: s.keep })
      .where(inArray(events.applicationId, s.drop));
    await db
      .update(applicationContacts)
      .set({ applicationId: s.keep })
      .where(inArray(applicationContacts.applicationId, s.drop));
    // A contact could now be linked to the survivor twice, once through each
    // copy. Collapse those to one.
    await db.execute(sql`
      delete from application_contacts a
      using application_contacts b
      where a.application_id = ${s.keep}
        and a.application_id = b.application_id
        and a.contact_id = b.contact_id
        and a.id > b.id`);
    await db.delete(applications).where(inArray(applications.id, s.drop));
  }

  console.log(`\nDeleted ${dropped.length} duplicate rows across ${survivors.length} groups.`);
  console.log("Now apply the migration that adds applications_user_firm_role_key.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
