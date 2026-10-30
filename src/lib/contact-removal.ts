import { and, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { contactSourcingOutcomes, contacts, emailDrafts } from "@/db/schema";

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * Delete one of a student's contacts. When contact generation produced it,
 * first record what had happened to it - a draft, marked sent, a reported
 * reply - against its sourcing run, because the delete severs every other
 * link (the contact row goes, and email_drafts.contact_id is set null).
 *
 * The snapshot holds the run id, the contact's rank and three booleans: no
 * name, firm, address or draft text. One transaction, so a snapshot never
 * exists for a contact that was not deleted, or the reverse.
 *
 * Returns whether a row was deleted.
 */
export async function removeContact(db: Db, userId: string, contactId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ sourcingRunId: contacts.sourcingRunId, sourcingRank: contacts.sourcingRank })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
    if (!row) return false;

    if (row.sourcingRunId) {
      const drafts = await tx
        .select({ sentAt: emailDrafts.sentAt, gotReply: emailDrafts.gotReply })
        .from(emailDrafts)
        .where(and(eq(emailDrafts.contactId, contactId), eq(emailDrafts.userId, userId)));
      const replies = drafts.map((d) => d.gotReply).filter((r): r is boolean => r !== null);
      await tx.insert(contactSourcingOutcomes).values({
        runId: row.sourcingRunId,
        sourcingRank: row.sourcingRank,
        event: "removed",
        hadDraft: drafts.length > 0,
        markedSent: drafts.some((d) => d.sentAt !== null),
        // Any reported reply wins; otherwise any reported "no"; otherwise unknown.
        gotReply: replies.includes(true) ? true : replies.length ? false : null,
      });
    }

    await tx.delete(contacts).where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
    return true;
  });
}
