/**
 * A schedule event can only be linked to the caller's OWN contact and
 * application.
 *
 * Both ids arrive from the form as arbitrary strings and were written to the
 * row unchecked; the Schedule page then joins them on id alone and serialises
 * contact.name and the application's firm and role to the client. The event's
 * owner was checked, but what it pointed AT was not - so another student's
 * contact id read back that contact's name, and their application id read back
 * its firm and role.
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";
import { asStudent } from "./helpers/as-student";
import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { applications, contacts, events, users } from "@/db/schema";
import { eq } from "drizzle-orm";

const ME = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OTHER = "ffffffff-ffff-4fff-8fff-ffffffffffff";

async function seeded(fn: (h: TestDatabase, ids: { contactId: string; applicationId: string }) => Promise<void>) {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    for (const [id, email] of [
      [ME, "me@example.edu"],
      [OTHER, "other@example.edu"],
    ] as const) {
      await h.db.insert(users).values({ id, email, passwordHash: "x", name: email, gradYear: 2028 });
    }
    // The OTHER student's private rows.
    const [c] = await h.db
      .insert(contacts)
      .values({ userId: OTHER, name: "Private Person", firm: "Secret Capital" })
      .returning({ id: contacts.id });
    const [a] = await h.db
      .insert(applications)
      .values({ userId: OTHER, firm: "Secret Capital", role: "Summer Analyst" })
      .returning({ id: applications.id });
    await fn(h, { contactId: c.id, applicationId: a.id });
  } finally {
    restore();
    await h.close();
  }
}

function eventForm(over: Record<string, string>): FormData {
  const f = new FormData();
  f.set("title", "Coffee chat");
  f.set("type", "meeting");
  f.set("eventDate", "2026-11-02T10:00");
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

test("creating an event cannot link another student's contact or application", async () => {
  await seeded(async (h, ids) => {
    const { createEvent } = await import("@/app/(app)/schedule/actions");
    const out = await asStudent(
      h.db,
      ME,
      () => createEvent(undefined, eventForm({ contactId: ids.contactId, applicationId: ids.applicationId })),
      { route: "/schedule" },
    );
    assert.equal(out?.error, undefined, `the event itself is still created: ${out?.error ?? ""}`);

    const [row] = await h.db.select().from(events).where(eq(events.userId, ME));
    assert.ok(row, "the event was created");
    assert.equal(row.contactId, null, "the foreign contact link was dropped");
    assert.equal(row.applicationId, null, "the foreign application link was dropped");
  });
});

test("the student's own contact and application still link", async () => {
  await seeded(async (h) => {
    const [mine] = await h.db
      .insert(contacts)
      .values({ userId: ME, name: "My Person", firm: "My Firm" })
      .returning({ id: contacts.id });
    const [myApp] = await h.db
      .insert(applications)
      .values({ userId: ME, firm: "My Firm", role: "Analyst" })
      .returning({ id: applications.id });

    const { createEvent } = await import("@/app/(app)/schedule/actions");
    await asStudent(
      h.db,
      ME,
      () => createEvent(undefined, eventForm({ contactId: mine.id, applicationId: myApp.id })),
      { route: "/schedule" },
    );

    const [row] = await h.db.select().from(events).where(eq(events.userId, ME));
    assert.equal(row.contactId, mine.id, "their own contact links as before");
    assert.equal(row.applicationId, myApp.id, "their own application links as before");
  });
});

test("editing an event cannot swap in another student's ids", async () => {
  await seeded(async (h, ids) => {
    const [row] = await h.db
      .insert(events)
      .values({ userId: ME, type: "meeting", title: "Mine", eventDate: new Date("2026-11-02T10:00:00Z") })
      .returning({ id: events.id });

    const { updateEvent } = await import("@/app/(app)/schedule/actions");
    const form = eventForm({
      eventId: row.id,
      contactId: ids.contactId,
      applicationId: ids.applicationId,
    });
    await asStudent(h.db, ME, () => updateEvent(undefined, form), { route: "/schedule" });

    const [after] = await h.db.select().from(events).where(eq(events.id, row.id));
    assert.equal(after.contactId, null, "no foreign contact after an edit");
    assert.equal(after.applicationId, null, "no foreign application after an edit");
  });
});
