import Link from "next/link";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { applications } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { getFirmDirectoryIndex } from "@/lib/firms";
import { getRelevantPostings } from "@/lib/internship-postings";
import { internshipYearFor } from "@/lib/internship-year";
import { CATEGORY_LABELS } from "@/lib/firm-metadata";
import { normalizeFirmName } from "@/lib/network-coverage";
import TrackedFirmList, { type TrackedFirm, type TrackedRole } from "./TrackedFirmList";

// Everything the student is tracking, grouped by firm, with the controls to
// stop.
//
// Deliberately not in the top nav. This is a maintenance screen - you come here
// to prune a list that has grown, not to browse - so it is reached from the
// places where noticing the list is too long actually happens: the bar under
// the Schedule, and the internships tab in Discovery.
export default async function TrackingPage() {
  const user = await getCurrentUser();
  const db = await getDb();

  /**
   * Three reads, issued together.
   *
   * The postings one is what lets this page show the SAME CARD the Internships
   * tab shows. An `applications` row carries a firm name, a role title and a
   * URL and nothing else - no deadline, no location, no industry, no
   * description - so the panel here used to be a list of bare titles while the
   * identical role two clicks away was a full posting card. Joining back to
   * the posting closes that gap, and it is the same query the Internships tab
   * runs, so the two views cannot disagree about what a role says.
   *
   * Matched on `firm|role`, which is what the pipeline already treats as an
   * application's identity (getTrackedKeys builds the same key, and there is
   * now a unique index on it). Applications store the firm as free text, so
   * there is no id to join on.
   */
  const [rows, allFirms, postings] = await Promise.all([
    db.query.applications.findMany({
      where: eq(applications.userId, user.id),
      orderBy: (a, { asc }) => [asc(a.firm), asc(a.role)],
    }),
    getFirmDirectoryIndex(),
    getRelevantPostings({
      gradYear: user.gradYear,
      internshipYear: internshipYearFor(user),
      // Not narrowed by sector: a student can track a role outside the sectors
      // they picked at onboarding, and the card for it should still be the
      // real one rather than the stub.
      preferredCategories: null,
    }),
  ]);

  const firmByKey = new Map(allFirms.map((f) => [normalizeFirmName(f.name), f]));
  const postingByKey = new Map(postings.map((p) => [`${p.firmName}|${p.roleTitle}`, p]));

  // The cycle a stub row is filed under. A manually added application has no
  // posting and therefore no programme year of its own; the student's own
  // cycle is the only honest answer, and null when they have not told us.
  const cycleYear = internshipYearFor(user);

  const byFirm = new Map<string, TrackedFirm>();
  for (const r of rows) {
    const existing = byFirm.get(r.firm);
    const match = firmByKey.get(normalizeFirmName(r.firm));
    const entry: TrackedFirm = existing ?? {
      firm: r.firm,
      firmSlug: match?.slug ?? null,
      firmWebsite: match?.website ?? null,
      roles: [],
    };

    const posting = postingByKey.get(`${r.firm}|${r.role}`);
    const role: TrackedRole = {
      // The APPLICATION's id, not the posting's - it is what /applications/[id]
      // and the untrack controls address, and a stub row has no posting id at
      // all.
      id: r.id,
      role: r.role,
      status: r.status,
      // The marker autoTrackInternships writes, so a student can tell what
      // they chose from what was chosen for them.
      autoTracked: !!r.notes?.startsWith("Auto-tracked from"),
      /**
       * Everything the card needs, from the posting when there is one.
       *
       * Null when there isn't - a firm the student typed in themselves, or a
       * role whose posting has since closed and left the relevant set. That
       * row still belongs on this page: it is theirs, and a page that quietly
       * dropped it would be hiding the student's own work. It renders as the
       * same card with the fields nobody has filled in left out, rather than
       * with invented ones.
       */
      posting: posting
        ? {
            id: posting.id,
            roleTitle: posting.roleTitle,
            location: posting.location,
            categories: posting.categories ?? [],
            programYear: posting.programYear,
            deadlineStatus: posting.deadlineStatus,
            deadlineText: posting.deadlineText,
            deadlineDate: posting.deadlineDate,
            descriptionFull: posting.descriptionFull,
            requirementsFull: posting.requirementsFull,
            sourceUrl: posting.sourceUrl,
            applicationUrl: posting.applicationUrl,
            recruiterName: posting.recruiterName,
            recruiterTitle: posting.recruiterTitle,
            recruiterEmail: posting.recruiterEmail,
            recruiterPhone: posting.recruiterPhone,
            firmSlug: posting.firmSlug,
            firmWebsite: posting.firmWebsite,
          }
        : null,
      applicationUrl: r.applicationUrl,
      cycleYear,
    };

    entry.roles.push(role);
    byFirm.set(r.firm, entry);
  }

  const firms = [...byFirm.values()].sort(
    (a, b) => b.roles.length - a.roles.length || a.firm.localeCompare(b.firm),
  );
  const roleCount = rows.length;

  return (
    <div>
      <div className="mb-6">
        <Link href="/discovery/internships" className="text-sm text-warmgray-500 hover:underline">
          ← Internships
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-brand-900">What you&apos;re tracking</h1>
        <p className="mt-1 max-w-2xl text-sm text-warmgray-500">
          {roleCount === 0
            ? "Nothing tracked yet."
            : `${roleCount} role${roleCount === 1 ? "" : "s"} across ${firms.length} firm${
                firms.length === 1 ? "" : "s"
              }. Open a firm to drop individual roles, or stop tracking the whole firm at once.`}
        </p>
      </div>

      <TrackedFirmList firms={firms} industryLabels={CATEGORY_LABELS} />
    </div>
  );
}
