import "server-only";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { consentEvents, users } from "@/db/schema";
import { POLICY_VERSION } from "@/lib/policy";

/**
 * Appends to the consent ledger (schema: consentEvents).
 *
 * Every screen that records a consent decision calls this after updating the
 * `users` columns, so the columns say what is true now and the ledger says how
 * it got there. Rows are never updated or deleted by the app.
 */

export type ConsentEventKind = (typeof consentEvents.$inferInsert)["kind"];
export type ConsentSource = "signup" | "consent_screen" | "onboarding" | "settings";

function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export async function recordConsentEvents(
  userId: string,
  kinds: ConsentEventKind[],
  source: ConsentSource,
  email?: string,
): Promise<void> {
  if (kinds.length === 0) return;
  const db = await getDb();
  let address = email;
  if (!address) {
    const row = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { email: true } });
    if (!row) return;
    address = row.email;
  }
  const emailHash = hashEmail(address);
  await db.insert(consentEvents).values(
    kinds.map((kind) => ({ userId, emailHash, kind, policyVersion: POLICY_VERSION, source })),
  );
}
