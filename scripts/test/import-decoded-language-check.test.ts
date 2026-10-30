/**
 * The language check runs on what an import stores, not on what carried it.
 *
 * The three bulk importers used to run blockedLanguageError over the posted
 * JSON text and parse it afterwards. That checks the transport encoding rather
 * than the words: "bullshit" inside a JSON string reads to a whole-word
 * matcher as no listed word at all, JSON.parse then decodes it, and the real
 * word is stored in the tracker, the contacts list or the schedule unchecked.
 * The project rule is that text is checked on the server before it is saved
 * (CLAUDE.md), so the check belongs after the parse.
 *
 *   node --import tsx --conditions=react-server --test \
 *     scripts/test/import-decoded-language-check.test.ts
 *
 * Real (in-memory) Postgres, no network. The blocked words come from the same
 * list scripts/content-limits-test.ts uses - nothing here invents one.
 */

import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

import "./helpers/no-network";
import { asStudent } from "./helpers/as-student";

// revalidatePath wants a request's static-generation store, which no plain
// Node test has. The actions call it after the last write, so it is stubbed
// out here the same way helpers/as-student.ts stubs next/navigation - before
// any action module is imported.
{
  const cachePath = require.resolve("next/cache");
  const stub = new Module(cachePath);
  stub.filename = cachePath;
  stub.loaded = true;
  stub.exports = { __esModule: true, revalidatePath: () => {}, revalidateTag: () => {} };
  require.cache[cachePath] = stub;
}

import { createTestDb, installAsAppDb, type TestDatabase } from "./helpers/test-db";
import { findBlockedLanguage } from "@/lib/content-limits";
import { applications, contacts, events, users } from "@/db/schema";

const USER_ID = "44444444-4444-4444-8444-444444444444";

async function withStudent(fn: (h: TestDatabase) => Promise<void>): Promise<void> {
  const h = await createTestDb();
  const restore = installAsAppDb(h.db);
  try {
    await h.db.insert(users).values({
      id: USER_ID,
      email: "import@example.edu",
      passwordHash: "x",
      name: "Import Student",
      school: "University of Southern California",
      gradYear: 2028,
    });
    await fn(h);
  } finally {
    restore();
    await h.close();
  }
}

/** A successful import redirects, which the next/navigation stub throws. */
async function run<T>(fn: () => Promise<T>): Promise<T | { redirected: true }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("NEXT_REDIRECT")) return { redirected: true };
    throw err;
  }
}

test("the raw JSON really does hide an escaped word from the matcher", () => {
  // The premise of the finding, asserted rather than assumed: this is why
  // checking the posted text instead of the parsed values was not a check.
  const raw = '[{"firm":"Acme","role":"Analyst","status":"not_started","notes":"this is b\\u0075llshit"}]';
  assert.equal(findBlockedLanguage(raw), null, "the transport text looks clean");
  assert.equal(findBlockedLanguage(JSON.parse(raw)[0].notes), "profanity", "the stored value is not");
});

test("an escaped word in imported application notes is refused, and nothing is stored", async () => {
  await withStudent(async (h) => {
    const { bulkImportApplications } = await import("@/app/(app)/applications/import/actions");
    const form = new FormData();
    form.set(
      "rows",
      '[{"firm":"Evercore","role":"Summer Analyst","status":"not_started","notes":"this is b\\u0075llshit","appliedDate":"","deadlineDate":""}]',
    );
    const result = await asStudent(h.db, USER_ID, () => run(() => bulkImportApplications(undefined, form)));
    assert.deepEqual(result, { error: '"Notes" contains profanity. Remove it to continue.' });
    assert.equal((await h.db.select().from(applications)).length, 0);
    assert.equal((await h.db.select().from(events)).length, 0);
  });
});

test("an escaped slur in an imported firm or role is refused by name", async () => {
  await withStudent(async (h) => {
    const { bulkImportApplications } = await import("@/app/(app)/applications/import/actions");
    const firmForm = new FormData();
    firmForm.set("rows", '[{"firm":"F\\u0061ggot Capital","role":"Analyst","status":"offer"}]');
    assert.deepEqual(
      await asStudent(h.db, USER_ID, () => run(() => bulkImportApplications(undefined, firmForm))),
      { error: '"Firm" contains a slur or hateful language. Remove it to continue.' },
    );

    const roleForm = new FormData();
    roleForm.set("rows", '[{"firm":"Evercore","role":"R\\u0065tard Analyst","status":"offer"}]');
    assert.deepEqual(
      await asStudent(h.db, USER_ID, () => run(() => bulkImportApplications(undefined, roleForm))),
      { error: '"Role" contains a slur or hateful language. Remove it to continue.' },
    );
    assert.equal((await h.db.select().from(applications)).length, 0);
  });
});

test("an escaped word in an imported contact is refused by the column it is in", async () => {
  await withStudent(async (h) => {
    const { bulkImportContacts } = await import("@/app/(app)/contacts/import/actions");
    const form = new FormData();
    form.set("rows", '[{"name":"Dana Reed","firm":"Evercore","notes":"total a$$hole"}]');
    assert.deepEqual(await asStudent(h.db, USER_ID, () => run(() => bulkImportContacts(undefined, form))), {
      error: '"Notes" contains profanity. Remove it to continue.',
    });

    const escaped = new FormData();
    escaped.set("rows", '[{"name":"Dana Reed","firm":"Evercore","notes":"total a\\u0073shole"}]');
    assert.deepEqual(await asStudent(h.db, USER_ID, () => run(() => bulkImportContacts(undefined, escaped))), {
      error: '"Notes" contains profanity. Remove it to continue.',
    });
    assert.equal((await h.db.select().from(contacts)).length, 0);
  });
});

test("an escaped word in an imported event title is refused, and nothing is stored", async () => {
  await withStudent(async (h) => {
    const { bulkImportScheduleEvents } = await import("@/app/(app)/schedule/actions");
    const form = new FormData();
    form.set("rows", '[{"title":"F\\u0075ck this class","isoDateTime":"2026-11-02T09:00"}]');
    const result = await asStudent(h.db, USER_ID, () => bulkImportScheduleEvents(undefined, form));
    assert.deepEqual(result, { error: '"The imported events" contains profanity. Remove it to continue.' });
    assert.equal((await h.db.select().from(events)).length, 0);
  });
});

test("an ordinary file still imports: applications, their deadline, contacts and events", async () => {
  await withStudent(async (h) => {
    const { bulkImportApplications } = await import("@/app/(app)/applications/import/actions");
    const appForm = new FormData();
    appForm.set(
      "rows",
      JSON.stringify([
        { firm: "Evercore", role: "IB Summer Analyst", status: "submitted", notes: "Referred by Dana", appliedDate: "2026-09-01", deadlineDate: "2026-11-14" },
        { firm: "Moelis & Company", role: "Summer Analyst", status: "not_started" },
      ]),
    );
    assert.deepEqual(
      await asStudent(h.db, USER_ID, () => run(() => bulkImportApplications(undefined, appForm))),
      { redirected: true },
    );
    const stored = await h.db.select().from(applications);
    assert.equal(stored.length, 2);
    assert.deepEqual(stored.map((a) => a.firm).sort(), ["Evercore", "Moelis & Company"]);
    const deadlines = await h.db.select().from(events);
    assert.equal(deadlines.length, 1);
    assert.equal(deadlines[0].title, "Evercore - IB Summer Analyst application deadline");

    const { bulkImportContacts } = await import("@/app/(app)/contacts/import/actions");
    const contactForm = new FormData();
    contactForm.set(
      "rows",
      JSON.stringify([
        { name: "Dana Reed", firm: "Evercore", role: "VP", email: "dana@evercore.com", linkedinUrl: "https://linkedin.com/in/dana", school: "USC", notes: "Met at the info session", lastContactDate: "2026-09-10" },
      ]),
    );
    assert.deepEqual(
      await asStudent(h.db, USER_ID, () => run(() => bulkImportContacts(undefined, contactForm))),
      { redirected: true },
    );
    const people = await h.db.select().from(contacts);
    assert.equal(people.length, 1);
    assert.equal(people[0].email, "dana@evercore.com");

    const { bulkImportScheduleEvents } = await import("@/app/(app)/schedule/actions");
    const eventForm = new FormData();
    eventForm.set(
      "rows",
      JSON.stringify([
        { title: "FNCE 100 lecture", isoDateTime: "2026-11-02T09:00" },
        { title: "Evercore superday", isoDateTime: "2026-11-05T13:00" },
      ]),
    );
    assert.deepEqual(
      await asStudent(h.db, USER_ID, () => bulkImportScheduleEvents(undefined, eventForm)),
      { imported: 2 },
    );
    assert.equal((await h.db.select().from(events)).length, 3);
  });
});
