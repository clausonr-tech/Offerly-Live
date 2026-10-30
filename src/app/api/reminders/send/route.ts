import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { sendDueReminderEmails } from "@/lib/reminder-emails";

// Trigger endpoint for the deadline reminder emails, driven by cron.
//
// Auth is the same shared-secret pattern as the crawler: without
// REMINDER_TRIGGER_SECRET set the route refuses to run rather than defaulting
// to open. An unauthenticated endpoint here would let anyone spray email from
// the product's sending domain, which is both a spam problem and a fast way to
// lose the domain's reputation.

export const maxDuration = 300;

function authorize(request: Request): string | null {
  const secret = process.env.REMINDER_TRIGGER_SECRET;
  if (!secret) {
    return "REMINDER_TRIGGER_SECRET is not set; refusing to send reminders.";
  }
  const provided = request.headers.get("authorization")?.replace(/^Bearer /, "");
  // Compared as fixed-length digests in constant time, so the response time
  // says nothing about how much of a guess was right.
  const digest = (v: string) => createHash("sha256").update(v).digest();
  if (!provided || !timingSafeEqual(digest(provided), digest(secret))) return "Unauthorized.";
  return null;
}

export async function POST(request: Request) {
  const authError = authorize(request);
  if (authError) {
    return NextResponse.json({ error: authError }, { status: 401 });
  }

  try {
    const result = await sendDueReminderEmails();
    return NextResponse.json(result);
  } catch (err) {
    console.error("reminder email run failed:", err);
    return NextResponse.json({ error: "Reminder run failed." }, { status: 500 });
  }
}
