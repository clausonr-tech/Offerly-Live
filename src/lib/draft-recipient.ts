import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts, directoryPeople, firms, submittedPeople, userTopFirms } from "@/db/schema";
import { CATEGORY_LABELS, type FirmProgramCategory } from "./firm-metadata";
import { isUuid } from "./firm-links";
import { normalizeFirmName } from "./network-coverage";

// Turns the draft form's recipient into a contact the draft can hang off.
//
// Three shapes arrive: one of the student's own contacts, a person from the
// shared directory, or someone typed in by hand. The last two are saved to the
// student's contacts - a draft, its follow-ups and its send all key off a
// contact row, and a person the student emails is by definition someone they
// are now in touch with.

type Contact = typeof contacts.$inferSelect;

export type ResolvedRecipient =
  | {
      contact: Contact;
      /** What the firm recruits for, as labels. Empty when the firm isn't in the directory. */
      firmDivisions: string[];
      /** The group the student says this person is in, for someone typed in by hand. */
      group: string | null;
    }
  | { error: string };

const EMAIL_PATTERN = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

function text(value: FormDataEntryValue | null, max: number): string | null {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

/** The firm behind a typed name: the student's matched firms first, then an exact directory name. */
export async function firmIdFor(userId: string, firmName: string): Promise<string | null> {
  const key = normalizeFirmName(firmName);
  if (!key) return null;
  const db = await getDb();
  const top = await db.query.userTopFirms.findMany({
    where: eq(userTopFirms.userId, userId),
    with: { firm: { columns: { id: true, name: true } } },
  });
  const hit = top.find((t) => normalizeFirmName(t.firm.name) === key);
  if (hit) return hit.firm.id;
  const exact = await db.query.firms.findFirst({
    where: eq(firms.name, firmName.trim()),
    columns: { id: true },
  });
  return exact?.id ?? null;
}

export async function divisionsFor(firmId: string | null): Promise<string[]> {
  if (!firmId) return [];
  const db = await getDb();
  const firm = await db.query.firms.findFirst({
    where: eq(firms.id, firmId),
    with: { programs: { columns: { category: true } } },
  });
  if (!firm) return [];
  return [
    ...new Set(firm.programs.map((p) => CATEGORY_LABELS[p.category as FirmProgramCategory] ?? p.category)),
  ];
}

/** Reuses a contact the student already has for this person rather than adding a duplicate. */
async function saveAsContact(
  userId: string,
  fields: {
    name: string;
    firm: string;
    role: string | null;
    email: string | null;
    linkedinUrl: string | null;
    school: string | null;
    background: string | null;
  },
): Promise<Contact> {
  const db = await getDb();
  const email = fields.email?.toLowerCase() ?? null;

  const existing = email
    ? await db.query.contacts.findFirst({
        where: and(eq(contacts.userId, userId), sql`lower(${contacts.email}) = ${email}`),
      })
    : await db.query.contacts.findFirst({
        where: and(
          eq(contacts.userId, userId),
          sql`lower(${contacts.name}) = ${fields.name.toLowerCase()}`,
          sql`lower(${contacts.firm}) = ${fields.firm.toLowerCase()}`,
        ),
      });
  if (existing) return existing;

  const [created] = await db
    .insert(contacts)
    .values({ userId, ...fields, email })
    .returning();
  return created;
}

export async function resolveRecipient(
  userId: string,
  recipient: string,
  formData: FormData,
): Promise<ResolvedRecipient> {
  // `contacts.id` and `directory_people.id` are `uuid` columns, so an id that
  // is not one arrives at Postgres as a malformed parameter and raises 22P02
  // out of whatever called this - a 500 where the student should get a
  // sentence (INPUT-2 F7). Checked here rather than at the callers so a future
  // one inherits it, and before the connection so a bad id never opens one.
  // The message is the branch's own not-found sentence: a malformed id and an
  // id that is not there are the same thing to the person reading it.
  for (const prefix of ["contact-", "directory-"] as const) {
    if (recipient.startsWith(prefix) && !isUuid(recipient.slice(prefix.length))) {
      return { error: prefix === "contact-" ? "Contact not found" : "That person is no longer listed at this firm." };
    }
  }

  const db = await getDb();

  if (recipient.startsWith("contact-")) {
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, recipient.slice("contact-".length)), eq(contacts.userId, userId)),
    });
    if (!contact) return { error: "Contact not found" };
    const firmId = contact.firm ? await firmIdFor(userId, contact.firm) : null;
    return { contact, firmDivisions: await divisionsFor(firmId), group: null };
  }

  if (recipient.startsWith("directory-")) {
    const person = await db.query.directoryPeople.findFirst({
      where: and(
        eq(directoryPeople.id, recipient.slice("directory-".length)),
        // Someone who has left the firm is not someone to email about it.
        isNull(directoryPeople.delistedAt),
      ),
    });
    if (!person) return { error: "That person is no longer listed at this firm." };
    const contact = await saveAsContact(userId, {
      name: person.name,
      firm: person.firmName,
      role: person.title,
      email: person.email,
      linkedinUrl: person.linkedinUrl,
      school: person.school,
      background: person.jobHistory,
    });
    const firmId = person.firmId ?? (await firmIdFor(userId, person.firmName));
    return { contact, firmDivisions: await divisionsFor(firmId), group: null };
  }

  if (recipient === "outside") {
    const name = text(formData.get("outsideName"), 200);
    const firm = text(formData.get("outsideFirm"), 200);
    if (!name || !firm) return { error: "Add the person's name and firm." };

    // Required: the address is what the internal collection is keyed on.
    const email = text(formData.get("outsideEmail"), 200)?.toLowerCase() ?? null;
    if (!email) return { error: "Add the person's email address." };
    if (!EMAIL_PATTERN.test(email)) return { error: "That email address doesn't look right." };
    const linkedinUrl = text(formData.get("outsideLinkedin"), 500);
    if (linkedinUrl && !/^https?:\/\//i.test(linkedinUrl)) {
      return { error: "Paste the full LinkedIn link, starting with https://" };
    }

    const group = text(formData.get("outsideGroup"), 200);
    const about = text(formData.get("outsideBackground"), 2000);
    const role = text(formData.get("outsideRole"), 200);
    const school = text(formData.get("outsideSchool"), 200);
    const contact = await saveAsContact(userId, {
      name,
      firm,
      role,
      email,
      linkedinUrl,
      school,
      background: [group && `Group: ${group}`, about].filter(Boolean).join(". ") || null,
    });

    // Into the internal collection, once per address. A person already there is
    // left exactly as they are - the first entry wins, and nothing a later
    // student types overwrites it. Never blocks the draft.
    try {
      await db
        .insert(submittedPeople)
        .values({ email, name, firm, role, group, school, linkedinUrl, background: about, submittedBy: userId })
        .onConflictDoNothing({ target: submittedPeople.email });
    } catch (e) {
      console.error("[submitted-people] could not save outside contact", e);
    }
    return { contact, firmDivisions: await divisionsFor(await firmIdFor(userId, firm)), group };
  }

  return { error: "Choose who this email is for" };
}
