"use server";

import { fillEmptyProfileFromLinkedIn } from "@/lib/profile-autofill";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { schools, users } from "@/db/schema";
import { getCurrentUserId } from "@/lib/current-user";
import { profileLinksSchema } from "@/lib/validation";
import { replaceStudentResume } from "@/lib/resume-profile";

export type ActionState = { error?: string } | undefined;

export async function saveProfileLinks(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  // The schema refuses a link carrying whitespace and hands back url.href, not
  // the raw input, so what is stored is only ever a URL - which is what this
  // action's blocked-language exemption claims (lib/validation).
  const parsed = profileLinksSchema.safeParse({
    linkedinUrl: formData.get("linkedinUrl") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // Optional. Loose on purpose - it is shown in an email signature as typed,
  // not dialled - but narrow enough that nothing but a phone number fits.
  const phone = String(formData.get("phone") ?? "").trim();
  if (phone && !/^[+()\d\s.-]{7,20}$/.test(phone)) {
    return { error: "Enter a phone number, or leave it blank." };
  }

  const updates: {
    linkedinUrl: string | null;
    phone?: string;
    profileLinksPromptedAt: Date;
    resumeFilename?: string;
    resumeStoragePath?: string;
    claimedSchoolId?: string;
    school?: string;
  } = {
    linkedinUrl: parsed.data.linkedinUrl || null,
    profileLinksPromptedAt: new Date(),
    ...(phone ? { phone } : {}),
  };

  // The submitted id is checked against the allowlist rather than trusted and
  // written straight through. It arrives from a <select>, but a form field is
  // a form field: without this an arbitrary uuid reaches a foreign key, and a
  // uuid belonging to some other row would either fail loudly at the database
  // or silently attach the wrong crest.
  const schoolId = formData.get("claimedSchoolId");
  if (typeof schoolId === "string" && schoolId) {
    const db = await getDb();
    const [school] = await db
      .select({ id: schools.id, name: schools.name })
      .from(schools)
      .where(eq(schools.id, schoolId))
      .limit(1);
    if (!school) return { error: "Pick a school from the list." };
    updates.claimedSchoolId = school.id;
    // Kept in step with the free-text column so everything already reading
    // `users.school` (profile form, matching, drafts) sees the pick too.
    updates.school = school.name;
  }

  const resume = formData.get("resume");
  if (resume instanceof File && resume.size > 0) {
    try {
      // Saved and read in one step, so the first email they draft already
      // knows their experience.
      await replaceStudentResume(await getCurrentUserId(), resume);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Couldn't upload resume." };
    }
  }

  const userId = await getCurrentUserId();
  const db = await getDb();
  await db.update(users).set(updates).where(eq(users.id, userId));
  // Fills an empty About me and major from the LinkedIn profile just given.
  if (updates.linkedinUrl) await fillEmptyProfileFromLinkedIn(userId, updates.linkedinUrl);

  redirect("/onboarding/verify-school");
}

export async function skipProfileLinks() {
  const userId = await getCurrentUserId();
  const db = await getDb();
  await db
    .update(users)
    .set({ profileLinksPromptedAt: new Date() })
    .where(eq(users.id, userId));

  redirect("/onboarding");
}
