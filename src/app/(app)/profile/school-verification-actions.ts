"use server";

import { revalidatePath } from "next/cache";
import { deleteAvatarFile } from "@/lib/avatar-storage";
import { and, eq, gt, isNotNull, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { beginLoginAttempt } from "@/lib/login-throttle";
import {
  MAX_CODE_ATTEMPTS,
  codeExpiresAt,
  codesMatch,
  generateVerificationCode,
  hashCode,
  resolveSchoolForEmail,
  sendSchoolEmailAlreadyVerified,
  sendVerificationEmail,
} from "@/lib/school-verification";
import {
  schoolVerificationConfirmSchema,
  schoolVerificationRequestSchema,
} from "@/lib/validation";

export type VerificationActionState = { error?: string; sent?: boolean } | undefined;

export async function requestSchoolVerification(
  _prevState: VerificationActionState,
  formData: FormData,
): Promise<VerificationActionState> {
  const parsed = schoolVerificationRequestSchema.safeParse({
    schoolEmail: formData.get("schoolEmail"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const schoolEmail = parsed.data.schoolEmail.trim().toLowerCase();

  // The allowlist lookup happens here *and* again at confirm time. Doing it
  // twice is deliberate: this call gives the student an immediate error, and
  // the confirm-time call is what actually decides `schoolId`, so a school
  // removed from the allowlist mid-flow can't slip through.
  const school = await resolveSchoolForEmail(schoolEmail);
  if (!school) {
    return {
      error:
        "That domain isn't a school we recognise yet. Use your official school email " +
        "(personal addresses like Gmail won't work), or contact us to get your school added.",
    };
  }

  // Re-verifying to a DIFFERENT school is allowed, and is the only way to
  // change one. It used to be refused here and sent to support, on the
  // reasoning that re-pointing an affiliation quietly is a bad thing to
  // permit. It is - but this is not quiet: the student has to hold an inbox at
  // the new school and read a code out of it, which is the same proof that
  // granted the first one. What the old rule actually protected was the
  // request step overwriting the existing verification, and that is fixed by
  // pendingSchoolEmail rather than by refusing the change.
  const userId = await getCurrentUserId();
  const db = await getDb();

  // At most five codes in 15 minutes per account, and per address. Each
  // code allows MAX_CODE_ATTEMPTS guesses, so this is what bounds guessing
  // overall - and what stops anyone using this form to flood a school inbox
  // with emails. Reuses the sign-in throttle's table (lib/login-throttle),
  // under keys no email can collide with.
  //
  // Charged BEFORE the "already claimed" lookup below, deliberately. The other
  // way round, the refusal for a claimed address came back unthrottled, so this
  // form answered "is this school address already verified on Offerly?" as
  // often as anyone cared to ask. Now every answer costs the same quota.
  for (const key of [`school-code:user:${userId}`, `school-code:to:${schoolEmail}`]) {
    const attempt = await beginLoginAttempt(key, null);
    if (attempt.blocked) return { error: "You've asked for several codes in a row. Wait a few minutes, then try again." };
  }

  // Another account holding this address would mean two students claiming the
  // same inbox, which is exactly what verification is supposed to prevent.
  //
  // The caller is told the same thing as anyone else - that a code is on its
  // way - rather than that the address is taken, which was a fact about
  // someone else's account. The person who actually holds the inbox is the one
  // told, by email, so a real attempt to take over their address reaches them
  // and a typo reaches nobody. No code is issued and nothing pending is
  // written, so the flow simply cannot be completed.
  const claimed = await db.query.users.findFirst({
    where: and(eq(users.schoolEmail, schoolEmail), isNotNull(users.schoolEmailVerifiedAt)),
  });
  if (claimed && claimed.id !== userId) {
    try {
      await sendSchoolEmailAlreadyVerified(schoolEmail);
    } catch {
      // Telling them is best-effort; it must not turn into a different answer.
    }
    revalidatePath("/profile");
    return { sent: true };
  }

  const code = generateVerificationCode();

  try {
    await sendVerificationEmail(schoolEmail, code);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to send verification email." };
  }

  await db
    .update(users)
    .set({
      // Written to the PENDING column. schoolEmail, schoolId and
      // schoolEmailVerifiedAt are left exactly as they are until a code comes
      // back, so a student who asks for a code and never finds the email still
      // has the school they had this morning.
      pendingSchoolEmail: schoolEmail,
      schoolVerificationCodeHash: hashCode(code),
      schoolVerificationExpiresAt: codeExpiresAt(),
      schoolVerificationAttempts: 0,
    })
    .where(eq(users.id, userId));

  revalidatePath("/profile");
  return { sent: true };
}

export async function confirmSchoolVerification(
  _prevState: VerificationActionState,
  formData: FormData,
): Promise<VerificationActionState> {
  const parsed = schoolVerificationConfirmSchema.safeParse({ code: formData.get("code") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const code = parsed.data.code;

  const userId = await getCurrentUserId();
  const db = await getDb();

  // Charge the attempt BEFORE comparing, in one statement: the count goes up
  // only while there is a live code with guesses left. Reading the count,
  // adding one in code and writing it back let a burst of parallel guesses
  // all see the same count - hundreds of tries against a six-digit code.
  const [user] = await db
    .update(users)
    .set({ schoolVerificationAttempts: sql`${users.schoolVerificationAttempts} + 1` })
    .where(
      and(
        eq(users.id, userId),
        isNotNull(users.schoolVerificationCodeHash),
        gt(users.schoolVerificationExpiresAt, new Date()),
        lt(users.schoolVerificationAttempts, MAX_CODE_ATTEMPTS),
      ),
    )
    .returning();

  if (!user?.schoolVerificationCodeHash) {
    return { error: "That code expired, or it had too many wrong tries. Request a new one." };
  }
  const codeHash = user.schoolVerificationCodeHash;

  if (!codesMatch(code, codeHash)) {
    // Burn the code once the attempt budget is gone, so guessing has to go
    // back through the (rate-limited) request step.
    const attempts = user.schoolVerificationAttempts;
    const exhausted = attempts >= MAX_CODE_ATTEMPTS;
    if (exhausted) {
      await db
        .update(users)
        .set({ schoolVerificationCodeHash: null, schoolVerificationExpiresAt: null, schoolVerificationAttempts: 0 })
        .where(and(eq(users.id, userId), eq(users.schoolVerificationCodeHash, codeHash)));
    }

    revalidatePath("/profile");
    return {
      error: exhausted
        ? "Too many incorrect attempts. Request a new code."
        : `Incorrect code. ${MAX_CODE_ATTEMPTS - attempts} attempt(s) left.`,
    };
  }

  // Re-resolve from the stored PENDING address rather than trusting anything
  // the form sent - this is the step that decides which school the student
  // belongs to.
  const pending = user.pendingSchoolEmail ?? user.schoolEmail;
  const school = pending ? await resolveSchoolForEmail(pending) : null;
  if (!school) {
    return { error: "We no longer recognise that school's email domain. Contact support." };
  }

  await db
    .update(users)
    .set({
      schoolEmailVerifiedAt: new Date(),
      schoolId: school.id,
      // The pending address becomes the real one only now.
      schoolEmail: pending,
      pendingSchoolEmail: null,
      // Keep the display field in step with the verified domain so the profile
      // can't show "Harvard" next to a verified @upenn.edu address.
      school: school.name,
      // The new school's crest becomes the picture.
      //
      // The crest is what renders whenever this column is null, so "adopt the
      // crest" is the same operation as "drop the override" - there is no
      // separate crest to write. Worth being explicit that this DISCARDS a
      // photo the student uploaded: verifying into a school is a deliberate
      // act that re-states who they are, and the new crest is the point of it.
      avatarStoragePath: null,
      schoolVerificationCodeHash: null,
      schoolVerificationExpiresAt: null,
      schoolVerificationAttempts: 0,
    })
    // Only while the code just matched is still the live one, so it is used once.
    .where(and(eq(users.id, userId), eq(users.schoolVerificationCodeHash, codeHash)));

  // Cleaned up after the row stops pointing at it, never before - the same
  // ordering uploadAvatar uses, so a crash leaves an orphaned file rather than
  // a row pointing at a deleted one.
  await deleteAvatarFile(user.avatarStoragePath);

  revalidatePath("/profile");
  revalidatePath("/dashboard");
  revalidatePath("/networking");
  revalidatePath("/networking");
  return { sent: true };
}
