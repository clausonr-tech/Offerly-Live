"use server";

import { revokeAllGoogleGrants } from "@/lib/google-connection";
import { blockedLanguageError } from "@/lib/content-limits";
import { revalidatePath } from "next/cache";
import { fillEmptyProfileFromLinkedIn } from "@/lib/profile-autofill";
import { redirect } from "next/navigation";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { activityEvents, detectedListings, firms, resumeReviews, users } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { clearRateLimit, rateLimit, retryAfterText } from "@/lib/rate-limit";
import { destroySession, hashPassword, revokeOtherSessions, verifyPassword } from "@/lib/auth";
import { parseInternships } from "@/lib/internships";
import { accountSchema, linkedinLink, moreAnswersSchema, passwordChangeSchema } from "@/lib/validation";
import { reanalyzeStudentResume, replaceStudentResume } from "@/lib/resume-profile";
import { isReadableResume } from "@/lib/resume-formats";
import { saveAvatarFile, deleteAvatarFile } from "@/lib/avatar-storage";
import { deleteStoredFiles } from "@/lib/file-store";
import { deleteResumeFiles } from "@/lib/resume-storage";
import { revokeResumeShareLink, rotateResumeShareLink } from "@/lib/resume-share";
import { prepareRecordingsForAccountDeletion } from "@/lib/video-interview/deletion-queue";
import { isTimeZone } from "@/lib/time-zone";

/**
 * Re-verifying the current password is a password guess like any other, and
 * these two were unbounded: a session left open on a shared or borrowed
 * machine could be used to try the real password as often as it liked, with
 * the sign-in throttle nowhere near this path. Bounded per account, because
 * the subject here is the signed-in session rather than an address or an IP.
 * Five in fifteen minutes is the budget sign-in gives a password.
 */
const REVERIFY_LIMIT = 5;
const REVERIFY_WINDOW_MS = 15 * 60_000;

async function reverifyBlocked(userId: string): Promise<string | null> {
  const gate = await rateLimit("reverify-password", userId, REVERIFY_LIMIT, REVERIFY_WINDOW_MS);
  return gate.allowed ? null : `Too many attempts. Try again in ${retryAfterText(gate.retryAfterMs)}.`;
}

/**
 * Every attempt is charged, so a parallel burst is counted - and the record is
 * forgotten the moment one succeeds, so the budget only ever bounds WRONG
 * answers. Charging a correct password would mean five legitimate visits to
 * these settings locked the student out of their own account for the window.
 */
async function reverifySucceeded(userId: string): Promise<void> {
  await clearRateLimit("reverify-password", userId);
}

export type AccountState = { error?: string; saved?: boolean } | undefined;
export type PhoneState = AccountState;


/** Name, school (and so crest), major and the public-profile settings - the "About you" block of the Account tab. */
export async function updateAccount(_prevState: AccountState, formData: FormData): Promise<AccountState> {
  const blocked = blockedLanguageError([
    ["Name", formData.get("name")],
    ["School", formData.get("school")],
    ["About me", formData.get("aboutMe")],
    ["Major", formData.get("major")],
  ]);
  if (blocked) return { error: blocked };

  const internships = parseInternships(formData.get("internships"));
  if ("error" in internships) return { error: internships.error };
  const blockedInternship = blockedLanguageError(
    internships.list.flatMap((i) => [
      ["Internship firm", i.firm] as [string, FormDataEntryValue],
      ["Internship role", i.role] as [string, FormDataEntryValue],
    ]),
  );
  if (blockedInternship) return { error: blockedInternship };

  const parsed = accountSchema.safeParse({
    name: formData.get("name"),
    school: formData.get("school") ?? "",
    aboutMe: formData.get("aboutMe") ?? "",
    // Unchecked checkboxes aren't submitted at all, so absence means false.
    showHometownOnProfile: formData.get("showHometownOnProfile") === "true",
    showInterestsOnProfile: formData.get("showInterestsOnProfile") === "true",
    major: formData.get("major") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const userId = await getCurrentUserId();
  const db = await getDb();

  // The logo comes from OUR record of a picked firm, never from the browser:
  // a firm id is looked up, and its website taken from the directory.
  const pickedIds = [...new Set(internships.list.map((i) => i.firmId).filter((id): id is string => !!id))];
  const picked = pickedIds.length
    ? await db.select({ id: firms.id, name: firms.name, website: firms.website }).from(firms).where(inArray(firms.id, pickedIds))
    : [];
  const byId = new Map(picked.map((f) => [f.id, f]));
  // A firm typed rather than picked still gets its logo when its name is
  // exactly one of ours ("lazard" -> Lazard).
  const typedNames = [...new Set(internships.list.filter((i) => !i.firmId).map((i) => i.firm.toLowerCase()))];
  const typed = typedNames.length
    ? await db
        .select({ id: firms.id, name: firms.name, website: firms.website })
        .from(firms)
        .where(and(inArray(sql`lower(${firms.name})`, typedNames), eq(firms.isDemo, false)))
    : [];
  const byName = new Map(typed.map((f) => [f.name.toLowerCase(), f]));
  const savedInternships = internships.list.map((i) => {
    const firm = i.firmId ? byId.get(i.firmId) : byName.get(i.firm.toLowerCase());
    return firm
      ? { firm: firm.name, firmId: firm.id, website: firm.website, role: i.role, start: i.start, end: i.end, current: i.current }
      : { firm: i.firm, firmId: null, website: null, role: i.role, start: i.start, end: i.end, current: i.current };
  });

  // This form NEVER writes the school any more, verified or not.
  //
  // A school is now only ever set by confirming an address at it - in
  // onboarding, or through the verification box further down this page. That
  // makes the trust boundary the same everywhere instead of depending on
  // whether the account happened to be verified yet, and it is why the field
  // above is read-only. The input being read-only is not the control: a form
  // POST is trivial to forge, so the server is where it has to hold, and the
  // way it holds is by not reading the field at all.

  await db
    .update(users)
    .set({
      name: parsed.data.name,
      aboutMe: parsed.data.aboutMe || null,
      showHometownOnProfile: parsed.data.showHometownOnProfile,
      showInterestsOnProfile: parsed.data.showInterestsOnProfile,
      major: parsed.data.major || null,
      internships: savedInternships,
    })
    .where(eq(users.id, userId));

  revalidatePath("/profile");
  revalidatePath("/contacts");
  revalidatePath("/dashboard");
  return { saved: true };
}

export type ResumeState = { error?: string; saved?: boolean; note?: string } | undefined;

/** The LinkedIn link, which goes in drafted emails' signatures. */
export async function updateLinkedin(_prevState: AccountState, formData: FormData): Promise<AccountState> {
  // Capped, refused if it carries whitespace, and stored as url.href rather
  // than as typed (lib/validation). This field is exempt from the
  // blocked-language check because a URL carries no words - true of what the
  // parser reads, and only true of what is stored because of this helper: the
  // value reaches the draft prompt's STUDENT block and the signature of the
  // email the student sends, so a newline in it opens a second section there.
  const link = linkedinLink(String(formData.get("linkedinUrl") ?? ""));
  if ("error" in link) return { error: link.error };
  const href = link.href;

  const userId = await getCurrentUserId();
  const db = await getDb();
  const before = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { linkedinUrl: true } });
  await db.update(users).set({ linkedinUrl: href }).where(eq(users.id, userId));

  // A new link fills an empty About me and major from the profile - one
  // lookup, only for a link we have not seen (lib/profile-autofill).
  if (href && href !== before?.linkedinUrl) await fillEmptyProfileFromLinkedIn(userId, href);

  revalidatePath("/profile");
  revalidatePath("/outreach");
  return { saved: true };
}

/** Replaces the resume and reads it, so drafted emails know the new one. */
export async function uploadResume(_prevState: ResumeState, formData: FormData): Promise<ResumeState> {
  const file = formData.get("resume");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a resume to upload." };

  const userId = await getCurrentUserId();
  try {
    const { summary } = await replaceStudentResume(userId, file);
    revalidatePath("/profile");
    revalidatePath("/outreach");
    return {
      saved: true,
      note: summary
        ? "Uploaded."
        : isReadableResume(file.name)
          ? "Uploaded, but it couldn't be read. Try again below."
          : "Uploaded. Older .doc files can't be read - save it as .docx or PDF so your emails can use it.",
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't upload that resume." };
  }
}

/** Reads the resume on file again. */
export async function reanalyzeResume(_prevState: ResumeState): Promise<ResumeState> {
  const userId = await getCurrentUserId();
  try {
    const summary = await reanalyzeStudentResume(userId);
    if (!summary) return { error: "There's no readable resume on file." };
    revalidatePath("/profile");
    revalidatePath("/outreach");
    return { saved: true };
  } catch (err) {
    console.error("[profile] re-reading resume failed", err);
    return { error: "Couldn't read your resume. Try again in a moment." };
  }
}

export type ResumeLinkState = { error?: string; path?: string; off?: boolean } | undefined;

/**
 * Turns the student's Resume Link off: a link already pasted into an email
 * stops working, and regenerating gives them a fresh one.
 *
 * The privacy policy ("Resume Link") promises both, and until now neither
 * existed in code - the token column had no writer, so a token in the table
 * was permanent. The settings control that calls these is still P-20
 * (legal/drafts/PRODUCT-TODO.md); the server side is here so the promise is
 * something the app can keep rather than something the UI will have to invent.
 */
export async function turnOffResumeLink(): Promise<ResumeLinkState> {
  const userId = await getCurrentUserId();
  await revokeResumeShareLink(userId);
  revalidatePath("/profile");
  return { off: true };
}

/** A new Resume Link, which kills the previous one. */
export async function regenerateResumeLink(): Promise<ResumeLinkState> {
  const userId = await getCurrentUserId();
  const token = await rotateResumeShareLink(userId);
  revalidatePath("/profile");
  return { path: `/r/${token}` };
}

/** Saves just the phone number. */
export async function updatePhone(_prevState: PhoneState, formData: FormData): Promise<PhoneState> {
  // Shown in an email signature as typed, so loose - but only phone characters.
  const phone = String(formData.get("phone") ?? "").trim();
  if (phone && !/^[+()\d\s.-]{7,20}$/.test(phone)) {
    return { error: "Enter a phone number, or leave it blank." };
  }

  const userId = await getCurrentUserId();
  const db = await getDb();
  await db.update(users).set({ phone: phone || null }).where(eq(users.id, userId));

  revalidatePath("/profile");
  revalidatePath("/outreach");
  revalidatePath("/profile/connections");
  return { saved: true };
}

/**
 * The student's time zone, or "auto" (stored as null) to follow their device
 * again. On the account, so it holds on every device they sign in from; see
 * lib/time-zone-server for how it outranks the zone the browser reports.
 */
export async function updateTimeZone(_prevState: AccountState, formData: FormData): Promise<AccountState> {
  const zone = String(formData.get("timeZone") ?? "").trim();
  if (zone !== "auto" && !isTimeZone(zone)) return { error: "Pick a time zone from the list." };

  const userId = await getCurrentUserId();
  const db = await getDb();
  await db
    .update(users)
    .set({ timeZone: zone === "auto" ? null : zone })
    .where(eq(users.id, userId));

  // Every page that shows a time reads the zone, so all of them are stale.
  revalidatePath("/", "layout");
  return { saved: true };
}

/** The two profile answers the recruiting-answers editor doesn't cover. */
export async function updateMoreAnswers(_prevState: AccountState, formData: FormData): Promise<AccountState> {
  const blocked = blockedLanguageError([
    ["Target group", formData.get("targetGroup")],
    ["A challenge you learned from", formData.get("challengeLearned")],
  ]);
  if (blocked) return { error: blocked };

  const parsed = moreAnswersSchema.safeParse({
    targetGroup: formData.get("targetGroup") ?? "",
    challengeLearned: formData.get("challengeLearned") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const userId = await getCurrentUserId();
  const db = await getDb();
  await db
    .update(users)
    .set({
      targetGroup: parsed.data.targetGroup || null,
      challengeLearned: parsed.data.challengeLearned || null,
    })
    .where(eq(users.id, userId));

  revalidatePath("/profile/interests");
  revalidatePath("/dashboard");
  return { saved: true };
}

export type AvatarState = { error?: string; ok?: boolean };

/**
 * Replaces the student's profile photo.
 *
 * The school crest stays the default and the fallback - this only ever sets an
 * override, so removing the photo restores the crest rather than leaving a
 * blank disc.
 */
export async function uploadAvatar(
  _prevState: AvatarState,
  formData: FormData,
): Promise<AvatarState> {
  const userId = await getCurrentUserId();
  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a photo first." };
  }

  let stored;
  try {
    stored = await saveAvatarFile(file);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "That photo could not be saved." };
  }

  const db = await getDb();
  const previous = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { avatarStoragePath: true },
  });
  await db.update(users).set({ avatarStoragePath: stored.storageKey }).where(eq(users.id, userId));
  // After the row points at the new file, never before: a crash between the
  // two should leave an orphaned file, not a row pointing at a deleted one.
  await deleteAvatarFile(previous?.avatarStoragePath);

  revalidatePath("/profile");
  revalidatePath("/networking");
  revalidatePath("/networking");
  return { ok: true };
}

export async function removeAvatar(): Promise<void> {
  const userId = await getCurrentUserId();
  const db = await getDb();
  const previous = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { avatarStoragePath: true },
  });
  await db.update(users).set({ avatarStoragePath: null }).where(eq(users.id, userId));
  await deleteAvatarFile(previous?.avatarStoragePath);
  revalidatePath("/profile");
  revalidatePath("/networking");
  revalidatePath("/networking");
}
