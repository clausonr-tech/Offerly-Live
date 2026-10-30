"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { emailConnections } from "@/db/schema";
import { getCurrentUser, getCurrentUserId } from "@/lib/current-user";
import { getEmailConnections, revokeGoogleGrant } from "@/lib/google-connection";
import { isTwilioConfigured, sendSms } from "@/lib/twilio";
import { rateLimit, retryAfterText } from "@/lib/rate-limit";

export type SmsState = { success?: boolean; error?: string } | undefined;

// A test message is a paid Twilio send to a number the student typed in (the
// stored phone is not proof-of-ownership verified), so it is a spend lever.
// Cap it per account: a handful of confirmations is all the feature needs, and
// the limit stops it being used to pump SMS at an arbitrary number.
const TEST_SMS_LIMIT = 5;
const TEST_SMS_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Test messages one NUMBER may receive a day, whoever asked for them.
 *
 * The per-account cap above bounds one account and nothing about one victim.
 * users.phone is typed in and explicitly not ownership-verified, so N accounts
 * typing one person's number sent 5N messages to it on Offerly's Twilio bill -
 * the account cap counting, diligently, the wrong party. The email side has
 * had a per-destination bound for exactly this reason (lib/firm-auth
 * chargeCodeQuota); this is the SMS one. Same number as the account cap: five
 * confirmations is all anybody's phone needs in a day, and a person using
 * their own number reaches their own cap first and sees the same sentence they
 * always did.
 */
const TEST_SMS_PER_NUMBER = 5;

/**
 * One phone number's identity for METERING ONLY - never for sending.
 *
 * Twilio is handed user.phone exactly as typed. This is only the subject the
 * limiter counts on, so it has to make the spellings of one number agree:
 * digits alone, with the North American country code supplied when it was
 * left off, so "+1 (555) 010-9999", "15550109999" and "555-010-9999" are one
 * destination rather than three budgets aimed at one handset. Anything else -
 * a shorter number, an international one - is counted on its digits as given,
 * which is already one subject per number.
 *
 * Not exported: every export of a "use server" module is a server action, and
 * a string normaliser has no business being callable from a browser.
 */
function smsDestination(phone: string): string {
  const digits = phone.replace(/\D+/g, "");
  return digits.length === 10 ? `1${digits}` : digits;
}

export async function sendTestSms(_prevState: SmsState): Promise<SmsState> {
  const user = await getCurrentUser();
  if (!user.phone) return { error: "Add a phone number first." };
  if (!isTwilioConfigured()) {
    return { error: "Twilio is not configured yet - add credentials to .env.local." };
  }
  const gate = await rateLimit("sms:test", user.id, TEST_SMS_LIMIT, TEST_SMS_WINDOW_MS);
  if (!gate.allowed) {
    return {
      error: `You've sent the maximum number of test messages for now. Try again in about ${retryAfterText(gate.retryAfterMs)}.`,
    };
  }
  // Charged after the account's own cap, so an account that has run out does
  // not spend its victim's budget too, and before the send, so nothing is
  // billed for a message this bound refuses.
  const toNumber = await rateLimit("sms:test:to", smsDestination(user.phone), TEST_SMS_PER_NUMBER, TEST_SMS_WINDOW_MS);
  if (!toNumber.allowed) {
    return {
      error: `That number has had too many test messages for now. Try again in about ${retryAfterText(toNumber.retryAfterMs)}.`,
    };
  }
  try {
    await sendSms(user.phone, "Offerly: this is a test message. SMS is connected.");
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to send" };
  }
}

export async function disconnectEmailConnection(connectionId: string) {
  const userId = await getCurrentUserId();
  const db = await getDb();
  // Cancelled at Google too, not only forgotten here.
  const connection = (await getEmailConnections(userId)).find((c) => c.id === connectionId);
  if (connection) await revokeGoogleGrant(connection);
  await db
    .delete(emailConnections)
    .where(and(eq(emailConnections.id, connectionId), eq(emailConnections.userId, userId)));

  revalidatePath("/profile/connections");
}
