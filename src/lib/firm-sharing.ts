import { and, eq, isNotNull, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { POLICY_VERSION } from "@/lib/policy";
import { recordConsentEvents, type ConsentSource } from "@/lib/consent-ledger";

/**
 * Who a firm may see, and what of them.
 *
 * THE one gate. A student reaches a firm - on Student matching, in a profile a
 * firm opens, anywhere - only through `sharedWithFirmsWhere()` and only as the
 * fields in `SHARED_PROFILE`. Nothing firm-facing reads the users table any
 * other way, so there is one place to check and one place to change.
 *
 * A student counts as sharing only when ALL of these hold:
 *   - they are a student account, not a club lead or a firm;
 *   - they opted in (firmSharingOptedInAt is set);
 *   - that opt-in was given under the CURRENT policy version, and their terms
 *     consent is at the current version too. A yes given under a policy that
 *     described sharing differently is not a yes to this one; they are asked
 *     again on the consent screen the version bump sends them to;
 *   - they are not a demo account.
 *
 * Turning sharing off clears the opt-in, so the student drops out of every
 * firm's results on the firm's next page load. Nothing is cached per firm.
 *
 * THE DEMO FIRM SEES DEMO STUDENTS ONLY. Its sign-in is published on
 * /firms/demo, so anyone can be it; handing it real students would publish
 * their profiles to the internet. `forDemoFirm` swaps the whole rule for
 * "synthetic demo student accounts", never real ones - the same split
 * firm-analytics makes with users.isDemo = firm.isDemo.
 */
export function sharedWithFirmsWhere(opts: { forDemoFirm?: boolean } = {}): SQL {
  if (opts.forDemoFirm) return and(eq(users.accountType, "student"), eq(users.isDemo, true))!;
  return and(
    eq(users.accountType, "student"),
    isNotNull(users.firmSharingOptedInAt),
    eq(users.firmSharingPolicyVersion, POLICY_VERSION),
    eq(users.consentedPolicyVersion, POLICY_VERSION),
    eq(users.isDemo, false),
  )!;
}

/** The same rule over a row already in hand. */
export function isSharingWithFirms(u: {
  accountType: string | null;
  firmSharingOptedInAt: Date | null;
  firmSharingPolicyVersion: string | null;
  consentedPolicyVersion: string | null;
  isDemo?: boolean | null;
}): boolean {
  return (
    u.accountType === "student" &&
    u.firmSharingOptedInAt !== null &&
    u.firmSharingPolicyVersion === POLICY_VERSION &&
    u.consentedPolicyVersion === POLICY_VERSION &&
    !u.isDemo
  );
}

/**
 * The student's own answer, for their own screens (Settings): did they opt in,
 * under the policy that is current? Deliberately NOT isSharingWithFirms, which
 * is the firm-side rule and also excludes demo accounts - using that here
 * showed a demo student who had just said yes an "Off" switch, and saving it
 * would have quietly turned their yes into a no.
 */
export function hasOptedInToFirmSharing(u: {
  firmSharingOptedInAt: Date | null;
  firmSharingPolicyVersion: string | null;
}): boolean {
  return u.firmSharingOptedInAt !== null && u.firmSharingPolicyVersion === POLICY_VERSION;
}

/**
 * Every column a firm may ever read about a student. Mirrors
 * FIRM_SHARING_SHARED in lib/policy.ts, which is what the student was shown.
 *
 * Deliberately absent: gpaBand and sponsorshipNeeded (onboarding promises GPA
 * is never shown to anyone), phone, hometown, resume TEXT (the file is shared,
 * by link, not its parsed contents), and everything the student wrote or
 * stored for their own use.
 *
 * resumeShareToken is absent too, and that is the point of this note. It was
 * selected here although nothing read it: the firm-facing shape exposes only
 * `hasResume`, derived from resumeStoragePath. The token is a bearer
 * capability - whoever holds it can fetch the resume from /r/<token> with no
 * account at all - so it has no business being read into a query answered for
 * another principal, whether or not today's serialiser happens to drop it.
 */
export const SHARED_PROFILE = {
  id: users.id,
  name: users.name,
  email: users.email,
  school: users.school,
  schoolId: users.schoolId,
  gradYear: users.gradYear,
  degreeLevel: users.degreeLevel,
  degreeProgram: users.degreeProgram,
  major: users.major,
  preferredCategories: users.preferredCategories,
  nicheInterests: users.nicheInterests,
  targetLocations: users.targetLocations,
  linkedinUrl: users.linkedinUrl,
  resumeStoragePath: users.resumeStoragePath,
} as const;

export const SHARED_PROFILE_FIELDS = Object.keys(SHARED_PROFILE);

/**
 * Record a student's answer. `on` stamps the current policy version with the
 * time; off clears both, which is what removes them from every firm's view.
 * Only ever for the signed-in student's own row - callers pass their own id.
 */
export async function setFirmSharing(userId: string, on: boolean, source: ConsentSource = "settings"): Promise<void> {
  const db = await getDb();
  const changed = await db
    .update(users)
    .set(
      on
        ? { firmSharingOptedInAt: new Date(), firmSharingPolicyVersion: POLICY_VERSION }
        : { firmSharingOptedInAt: null, firmSharingPolicyVersion: null },
    )
    .where(and(eq(users.id, userId), eq(users.accountType, "student")))
    .returning();
  // The columns above keep only the current answer; the ledger keeps every one.
  if (changed[0]) await recordConsentEvents(userId, [on ? "firm_sharing_on" : "firm_sharing_off"], source, changed[0].email);
}
