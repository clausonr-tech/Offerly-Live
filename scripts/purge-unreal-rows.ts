/**
 * Removes the rows the estimated-window machinery already wrote.
 *
 * The code that produced these is gone (see lib/deadline-reminders.ts and the
 * `includeUnopened` removal in lib/internship-postings.ts), but the rows it
 * wrote are still in the database and are still what the student sees. This
 * clears them, once.
 *
 * TWO THINGS, AND ONLY THESE TWO:
 *
 *  1. `events` of type "deadline" whose title carries "(estimated window)".
 *     Every one of these was manufactured from `firm_programs.timing_guidance`
 *     - prose, never a date - plus a graduation year. The title is the
 *     seeder's own marker, not anything a student typed, so matching on it
 *     cannot catch a real event. An event the student has edited the title of
 *     no longer matches and is left alone, which is the right way round.
 *
 *  2. `applications` rows marked "Auto-tracked from..." that no longer
 *     correspond to a real posting in this student's own cycle - the set the
 *     Internships tab shows them. These were written by auto-tracking under
 *     the older, looser rules: skeleton placeholder rows, and postings from a
 *     cycle that has since closed.
 *
 * IT NEVER TOUCHES A ROW THE STUDENT MADE. Anything without the auto-track
 * marker is theirs - including a firm we have no posting for at all, which is
 * a perfectly good thing to track and the exact row a careless "delete what we
 * can't match" would destroy. Same for any application with an interview,
 * offer or rejection recorded against it, which is history regardless of how
 * the row was created.
 *
 * Read-only unless you pass --apply:
 *
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/purge-unreal-rows.ts
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/purge-unreal-rows.ts --apply
 */
import { and, eq, inArray, like } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applications, events, firms, internshipPostings, users } from "@/db/schema";
import { isRealPosting, postingIsForStudent } from "@/lib/internship-postings";
import { internshipYearFor } from "@/lib/internship-year";

const APPLY = process.argv.includes("--apply");

/** Statuses that mean something actually happened. Never deleted. */
const HAS_HISTORY = new Set(["interviewing", "offer", "rejected", "accepted", "withdrawn"]);

async function main() {
  const db = await getDb();

  // ---------- 1. the manufactured calendar events ----------
  const bogusEvents = await db
    .select({ id: events.id, userId: events.userId, title: events.title })
    .from(events)
    .where(and(eq(events.type, "deadline"), like(events.title, "%(estimated window)%")));

  console.log(`\nestimated-window deadline events: ${bogusEvents.length}`);
  for (const e of bogusEvents.slice(0, 3)) console.log(`   e.g. ${e.title}`);

  // ---------- 2. auto-tracked applications with nothing real behind them ----------
  const allUsers = await db
    .select({
      id: users.id,
      email: users.email,
      gradYear: users.gradYear,
      targetInternshipYear: users.targetInternshipYear,
    })
    .from(users);

  // Every active posting, once, joined to its firm name - which is the only
  // thing applications carry. They store the firm as free text, so there is no
  // id to join on; this is the same (firm, role) key the pipeline itself
  // treats as one application.
  const postings = await db
    .select({
      firmName: firms.name,
      roleTitle: internshipPostings.roleTitle,
      programYear: internshipPostings.programYear,
      eligibleGradYears: internshipPostings.eligibleGradYears,
      descriptionFull: internshipPostings.descriptionFull,
      deadlineText: internshipPostings.deadlineText,
      deadlineStatus: internshipPostings.deadlineStatus,
    })
    .from(internshipPostings)
    .innerJoin(firms, eq(internshipPostings.firmId, firms.id))
    .where(eq(internshipPostings.isActive, true));

  const byKey = new Map<string, (typeof postings)[number][]>();
  for (const p of postings) {
    const k = `${p.firmName}|${p.roleTitle}`;
    byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }

  const doomed: { id: string; email: string; firm: string; role: string; why: string }[] = [];

  for (const u of allUsers) {
    const rows = await db
      .select({
        id: applications.id,
        firm: applications.firm,
        role: applications.role,
        status: applications.status,
        notes: applications.notes,
      })
      .from(applications)
      .where(eq(applications.userId, u.id));

    const internshipYear = internshipYearFor(u);

    for (const r of rows) {
      if (!r.notes?.startsWith("Auto-tracked from")) continue;
      if (r.status && HAS_HISTORY.has(r.status)) continue;

      const candidates = byKey.get(`${r.firm}|${r.role}`) ?? [];
      // The same two gates the Internships tab applies, in the same order.
      const keeps = candidates.some(
        (p) =>
          isRealPosting(p) &&
          postingIsForStudent(p, { internshipYear, gradYear: u.gradYear }),
      );
      if (keeps) continue;

      const why = candidates.length === 0
        ? "no posting"
        : candidates.some((p) => !isRealPosting(p))
          ? "placeholder / not open yet"
          : "wrong cycle";
      doomed.push({ id: r.id, email: u.email, firm: r.firm, role: r.role, why });
    }
  }

  console.log(`\nauto-tracked applications with nothing real behind them: ${doomed.length}`);
  const byUser = new Map<string, Map<string, number>>();
  for (const d of doomed) {
    const m = byUser.get(d.email) ?? new Map<string, number>();
    m.set(d.why, (m.get(d.why) ?? 0) + 1);
    byUser.set(d.email, m);
  }
  for (const [email, reasons] of byUser) {
    console.log(`   ${email}: ${[...reasons].map(([w, n]) => `${n} ${w}`).join(", ")}`);
  }

  if (!APPLY) {
    console.log("\nDRY RUN - nothing deleted. Re-run with --apply to remove these.");
    return;
  }

  // Chunked: Postgres has a bind-parameter ceiling and these lists run to
  // hundreds of ids.
  const chunk = <T,>(xs: T[], n = 200) =>
    Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

  for (const ids of chunk(bogusEvents.map((e) => e.id))) {
    await db.delete(events).where(inArray(events.id, ids));
  }
  for (const ids of chunk(doomed.map((d) => d.id))) {
    await db.delete(applications).where(inArray(applications.id, ids));
  }
  console.log(`\nDeleted ${bogusEvents.length} events and ${doomed.length} applications.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
