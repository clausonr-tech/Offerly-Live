"use server";

import { blockedInForm } from "@/lib/content-limits";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { contactSchema } from "@/lib/validation";
import { removeContact } from "@/lib/contact-removal";

export type ActionState = { error?: string } | undefined;

const CONTACT_LABELS: Record<string, string> = {
  name: "Name",
  firm: "Firm",
  role: "Role",
  school: "School",
  background: "Background",
  notes: "Notes",
  email: "Email",
  linkedinUrl: "LinkedIn",
};

function readContactForm(formData: FormData) {
  return contactSchema.safeParse({
    name: formData.get("name"),
    firm: formData.get("firm") ?? "",
    role: formData.get("role") ?? "",
    linkedinUrl: formData.get("linkedinUrl") ?? "",
    email: formData.get("email") ?? "",
    school: formData.get("school") ?? "",
    background: formData.get("background") ?? "",
    notes: formData.get("notes") ?? "",
    relationshipStatus: formData.get("relationshipStatus"),
    lastContactDate: formData.get("lastContactDate") ?? "",
  });
}

export async function createContact(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = readContactForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const blocked = blockedInForm(formData, CONTACT_LABELS, ["relationshipStatus", "lastContactDate"]);
  if (blocked) return { error: blocked };

  const userId = await getCurrentUserId();
  const db = await getDb();
  const [created] = await db
    .insert(contacts)
    .values({
      userId,
      name: parsed.data.name,
      firm: parsed.data.firm || null,
      role: parsed.data.role || null,
      linkedinUrl: parsed.data.linkedinUrl || null,
      email: parsed.data.email || null,
      school: parsed.data.school || null,
      background: parsed.data.background || null,
      notes: parsed.data.notes || null,
      relationshipStatus: parsed.data.relationshipStatus,
      lastContactDate: parsed.data.lastContactDate || null,
    })
    .returning();

  revalidatePath("/contacts");
  redirect(`/contacts/${created.id}`);
}

export async function updateContact(
  contactId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = readContactForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const blocked = blockedInForm(formData, CONTACT_LABELS, ["relationshipStatus", "lastContactDate"]);
  if (blocked) return { error: blocked };

  const userId = await getCurrentUserId();
  const db = await getDb();
  await db
    .update(contacts)
    .set({
      name: parsed.data.name,
      firm: parsed.data.firm || null,
      role: parsed.data.role || null,
      linkedinUrl: parsed.data.linkedinUrl || null,
      email: parsed.data.email || null,
      school: parsed.data.school || null,
      background: parsed.data.background || null,
      notes: parsed.data.notes || null,
      relationshipStatus: parsed.data.relationshipStatus,
      lastContactDate: parsed.data.lastContactDate || null,
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));

  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
  redirect(`/contacts/${contactId}`);
}

export async function deleteContact(contactId: string) {
  const userId = await getCurrentUserId();
  const db = await getDb();
  // Records a generated contact's outcomes against its sourcing run before
  // the row goes - see lib/contact-removal.
  await removeContact(db, userId, contactId);

  revalidatePath("/contacts");
  redirect("/contacts");
}
