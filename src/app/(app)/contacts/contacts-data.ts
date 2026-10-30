import { desc, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { contacts, outreachSends } from "@/db/schema";
import { ladderState } from "@/lib/outreach-ladder";
import { PREVIEW_SIZE, spreadAcrossFirms } from "@/lib/contact-spread";
import { scoreResponseLikelihood, type ScorableStudent } from "@/lib/response-likelihood";

import type { ContactRow, OutreachView } from "./ContactGrid";
import { getStudentTimeZone } from "@/lib/time-zone-server";

/**
 * One student's contacts, scored.
 *
 * Shared by the Networking hub and the full sheet so the two cannot disagree
 * about someone's match - which they would the moment either page grew its
 * own query and passed the scorer a different set of columns.
 */
export async function loadScoredContacts(
  user: ScorableStudent & { id: string },
): Promise<ContactRow[]> {
  const db = await getDb();

  // Plain column select, deliberately not a relational `with:` query - those
  // generate the LEFT JOIN LATERAL shape that aborts PGlite's WASM engine
  // (see the note at src/lib/auth.ts:83).
  const [rows, sends] = await Promise.all([
    db.query.contacts.findMany({
    where: eq(contacts.userId, user.id),
    columns: {
      id: true,
      name: true,
      firm: true,
      role: true,
      email: true,
      emailConfidence: true,
      school: true,
      linkedinUrl: true,
      connectionAngle: true,
      relationshipStatus: true,
      lastContactDate: true,
      updatedAt: true,
      background: true,
      notes: true,
      gradYear: true,
      currentCity: true,
    },
    orderBy: [desc(contacts.createdAt)],
    }),
    db.query.outreachSends.findMany({
      where: eq(outreachSends.userId, user.id),
      columns: { id: true, contactId: true, step: true, sentAt: true, source: true },
    }),
  ]);

  const sendsBy = new Map<string, typeof sends>();
  for (const s of sends) sendsBy.set(s.contactId, [...(sendsBy.get(s.contactId) ?? []), s]);
  const now = new Date();
  const timeZone = await getStudentTimeZone();

  /** Where this contact's cold emails stand, as the table shows it. Dates go
   *  over as strings: nothing crosses into a client component as a Date. */
  function outreachFor(row: (typeof rows)[number]): OutreachView {
    const own = sendsBy.get(row.id) ?? [];
    const state = ladderState(row, own, now, timeZone);
    const top = [...own].sort((a, b) => b.step - a.step)[0];
    return {
      stage: state.stage,
      sends: state.sends.map((s) => ({ step: s.step, sentAt: s.sentAt.toISOString() })),
      nextStep: state.nextStep,
      dueAt: state.dueAt?.toISOString() ?? null,
      // Only a recorded email can be taken back; an implied first email from
      // before the ladder existed has no row to delete.
      undoSendId: top?.id ?? null,
    };
  }

  // The same scorer the firm cards use, rather than a second number that
  // disagrees with it. Computed here rather than stored, so every row reflects
  // the student's profile as it is NOW - change your target city and the whole
  // table re-scores, which a column frozen at save time could never do.
  return rows.map(({ updatedAt: _updatedAt, ...row }) => ({
    ...row,
    outreach: outreachFor({ ...row, updatedAt: _updatedAt }),
    match: scoreResponseLikelihood(user, {
      name: row.name,
      firmName: row.firm ?? "",
      title: row.role,
      school: row.school,
      gradYear: row.gradYear,
      email: row.email,
      linkedinUrl: row.linkedinUrl,
      // Own contacts keep their history as free text rather than columns.
      // The city rides in the free text, which is where the scorer looks for
      // a target-location match.
      freeText: [row.background, row.notes, row.connectionAngle, row.currentCity]
        .filter(Boolean)
        .join(" ⋄ "),
    }),
  }))
    // Grouped by firm, strongest first within each.
    //
    // The table's job is "who do I know at the places I am working", and a
    // student reads it a firm at a time - every Goldman contact together, then
    // every Evercore one. Newest-first answered a different question and
    // scattered each firm's people through the list, so comparing two people
    // at the same bank meant scrolling past everyone generated in between.
    //
    // Sorted here rather than in SQL because the tiebreak is the match score,
    // which is computed above from the student's profile as it is now and does
    // not exist as a column. The SQL order (newest first) survives underneath
    // as the final tiebreak, since Array.prototype.sort is stable.
    //
    // Contacts with no firm sort to the bottom rather than under an empty
    // heading - they are usually the ones added by hand mid-conversation, and
    // they are the least useful rows to lead with.
    .sort((a, b) => {
      const firmA = a.firm?.trim() ?? "";
      const firmB = b.firm?.trim() ?? "";
      if (firmA !== firmB) {
        if (!firmA) return 1;
        if (!firmB) return -1;
        return firmA.localeCompare(firmB);
      }
      return b.match.score - a.match.score;
    });
}

// Re-exported so the hub imports its data and its preview rule from one place.
// The rule itself lives in lib, where a test can reach it without pulling in
// the database client this module needs.
export { PREVIEW_SIZE, spreadAcrossFirms };
