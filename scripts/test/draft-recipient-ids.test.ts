/**
 * `resolveRecipient` and the ids it is handed, against a REAL database.
 *
 * `contacts.id` and `directory_people.id` are `uuid` columns. An id that is
 * not a uuid reaches Postgres as a malformed `uuid` parameter and raises
 * `22P02` out of the server action, so the student gets a 500 where they
 * should get a sentence (INPUT-2 F7 / INPUT-3 F7).
 *
 * The caller-side guard (`recipientIdError` in drafts/draft-request) already
 * covers the one caller in the app. These cases cover the RESOLVER, so a
 * future caller - a route, a script, the quick-draft path - inherits the check
 * instead of re-deriving it.
 *
 * PGlite, migrated by replaying drizzle/*.sql: the `uuid` columns are the real
 * ones, which is the whole point. A stub that accepted any string would prove
 * nothing about the error this exists to stop.
 *
 * NO LIVE CALLS and no connection string.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import "./helpers/no-network";
import { createTestDb, type TestDatabase } from "./helpers/test-db";
import { resolveRecipient } from "@/lib/draft-recipient";

let h: TestDatabase;
let previousDb: unknown;

before(async () => {
  h = await createTestDb();
  previousDb = (globalThis as { __dbPromise?: unknown }).__dbPromise;
  (globalThis as { __dbPromise?: unknown }).__dbPromise = Promise.resolve(h.db);
});

after(async () => {
  (globalThis as { __dbPromise?: unknown }).__dbPromise = previousDb;
  await h.close();
});

/** The resolver's answer, or the error it raised instead of answering. */
async function resolve(recipient: string) {
  try {
    const r = await resolveRecipient("00000000-0000-4000-8000-000000000001", recipient, new FormData());
    return "error" in r ? { kind: "refused" as const, message: r.error } : { kind: "resolved" as const };
  } catch (err) {
    const parts: string[] = [];
    let current: unknown = err;
    while (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    }
    return { kind: "threw" as const, message: parts.join(" <- ") };
  }
}

for (const recipient of ["contact-notauuid", "contact-", "contact-12345", "contact-' OR 1=1 --"]) {
  test(`a contact id that is not a uuid is refused, not sent to Postgres: ${JSON.stringify(recipient)}`, async () => {
    const r = await resolve(recipient);
    assert.equal(r.kind, "refused", r.kind === "threw" ? r.message : r.kind);
  });
}

for (const recipient of ["directory-notauuid", "directory-", "directory-12345"]) {
  test(`a directory id that is not a uuid is refused, not sent to Postgres: ${JSON.stringify(recipient)}`, async () => {
    const r = await resolve(recipient);
    assert.equal(r.kind, "refused", r.kind === "threw" ? r.message : r.kind);
  });
}

test("the refusal is the same sentence as a row that is not there, so the guard says nothing new", async () => {
  const absent = await resolve("contact-00000000-0000-4000-8000-0000000000ff");
  const malformed = await resolve("contact-notauuid");
  assert.equal(absent.kind, "refused", absent.kind === "threw" ? absent.message : absent.kind);
  assert.equal(malformed.kind, "refused", malformed.kind === "threw" ? malformed.message : malformed.kind);
  assert.equal(
    malformed.kind === "refused" ? malformed.message : "",
    absent.kind === "refused" ? absent.message : "",
  );
});

test("a well-formed uuid still reaches the lookup", async () => {
  // Not-found rather than refused-on-shape: the guard must not have swallowed
  // the real query path.
  const r = await resolve("directory-00000000-0000-4000-8000-0000000000ff");
  assert.equal(r.kind, "refused", r.kind === "threw" ? r.message : r.kind);
  assert.equal(r.kind === "refused" ? r.message : "", "That person is no longer listed at this firm.");
});

test('"outside" is not an id and is untouched by the guard', async () => {
  // No name and no firm typed, so it refuses for the reason it always did.
  const r = await resolve("outside");
  assert.equal(r.kind, "refused", r.kind === "threw" ? r.message : r.kind);
  assert.equal(r.kind === "refused" ? r.message : "", "Add the person's name and firm.");
});
