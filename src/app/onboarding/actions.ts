"use server";

import { blockedLanguageError } from "@/lib/content-limits";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users, userTopFirms } from "@/db/schema";
import { getCurrentUser, getCurrentUserId } from "@/lib/current-user";
import { hasPaidAccess } from "@/lib/plan-access";
import { MATCHED_FIRMS } from "@/lib/match-config";
import { matchTopFirmsForUser } from "@/lib/match-top-firms";
import { onboardingSchema } from "@/lib/validation";
import { parseInternshipYearAnswer } from "@/lib/internship-year";
import { POLICY_VERSION } from "@/lib/policy";
import { setFirmSharing } from "@/lib/firm-sharing";
import { recordConsentEvents } from "@/lib/consent-ledger";
import { canonicalCountry } from "@/lib/countries";

export type ActionState = { error?: string } | undefined;

/** "" -> null, so an unanswered question is genuinely absent rather than an
 *  empty string that later reads as "answered with nothing". */
const orNull = (v: string) => (v.trim() ? v.trim() : null);
const arrOrNull = (v: string[]) => (v.length ? v : null);

export async function completeOnboarding(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const one = (k: string) => String(formData.get(k) ?? "");

  // The last step (ConsentStep in the wizard). The terms are required; sharing
  // with firms is not, and is its own box, so agreeing to one is never read as
  // agreeing to the other.
  if (one("acceptTerms") !== "on") {
    return { error: "Please agree to the Terms of Service and Privacy Policy to finish." };
  }
  const shareWithFirms = one("shareWithFirms") === "on";

  const blocked = blockedLanguageError([
    ["Clubs and activities", one("clubsAndActivities")],
    ["What draws you to finance", one("motivations")],
    ["How you like to work", one("workStyle")],
    ["An experience you're proud of", one("proudExperience")],
    ["Interests", one("interests")],
    ["Major", one("major")],
    ["Hometown", one("hometown")],
  ]);
  if (blocked) return { error: blocked };

  const parsed = onboardingSchema.safeParse({
    preferredCategories: formData.getAll("preferredCategories"),
    nicheInterests: formData.getAll("nicheInterests"),
    ibTierPreferences: formData.getAll("ibTierPreferences"),
    peTierPreferences: formData.getAll("peTierPreferences"),
    targetLocations: formData.getAll("targetLocations"),
    priorExperience: formData.getAll("priorExperience"),
    onboardingUnsure: formData.getAll("onboardingUnsure"),
    degreeLevel: one("degreeLevel"),
    recruitingStage: one("recruitingStage"),
    gradYear: one("gradYear"),
    targetInternshipYear: one("targetInternshipYear"),
    clubsAndActivities: one("clubsAndActivities"),
    technicalReadiness: one("technicalReadiness"),
    motivations: one("motivations"),
    workStyle: one("workStyle"),
    proudExperience: one("proudExperience"),
    interests: one("interests"),
    major: one("major"),
    hometown: one("hometown"),
    homeCountry: one("homeCountry"),
    sponsorshipNeeded: one("sponsorshipNeeded"),
    gpaBand: one("gpaBand"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;

  // Only a country from the list is kept, in the list's spelling. Anything
  // else typed is refused rather than stored, so matching by country never
  // has to guess what "USA" or "Untied States" meant.
  const homeCountry = canonicalCountry(d.homeCountry);
  if (d.homeCountry.trim() && !homeCountry) {
    return { error: "Pick your country from the list, or leave it blank." };
  }

  // gradYear arrives as a label ("2028", "Graduate student"). Only persist it
  // to the integer column when it really is a year.
  const gradYearNum = /^\d{4}$/.test(d.gradYear) ? Number(d.gradYear) : null;

  // "Summer 2028" -> 2028. Same treatment as gradYear: the answer is a label,
  // and only a real year is persisted, so "I'm not sure yet" leaves the column
  // null and internshipYearFor() falls back to gradYear - 1.
  const internshipYearNum = parseInternshipYearAnswer(d.targetInternshipYear);

  const userId = await getCurrentUserId();
  const db = await getDb();

  await db
    .update(users)
    .set({
      preferredCategories: d.preferredCategories,
      nicheInterests: arrOrNull(d.nicheInterests),
      ibTierPreferences: arrOrNull(d.ibTierPreferences),
      peTierPreferences: arrOrNull(d.peTierPreferences),
      targetLocations: arrOrNull(d.targetLocations),
      priorExperience: arrOrNull(d.priorExperience),
      onboardingUnsure: arrOrNull(d.onboardingUnsure),
      // The wizard's first, required question - and it was never saved, so
      // every account finished onboarding with no degree level and the
      // postings for the other degree stayed on its list. Stored as the label,
      // the same as the Interests page stores it; normalizeDegreeLevel reads both.
      degreeLevel: orNull(d.degreeLevel),
      recruitingStage: orNull(d.recruitingStage),
      ...(gradYearNum ? { gradYear: gradYearNum } : {}),
      ...(internshipYearNum ? { targetInternshipYear: internshipYearNum } : {}),
      clubsAndActivities: orNull(d.clubsAndActivities),
      technicalReadiness: orNull(d.technicalReadiness),
      motivations: orNull(d.motivations),
      workStyle: orNull(d.workStyle),
      proudExperience: orNull(d.proudExperience),
      interests: orNull(d.interests),
      major: orNull(d.major),
      hometown: orNull(d.hometown),
      homeCountry,
      sponsorshipNeeded: orNull(d.sponsorshipNeeded),
      gpaBand: orNull(d.gpaBand),
      onboardingCompletedAt: new Date(),
      // Re-stamped here because the student just agreed again, to the version
      // on screen - the one this server is running, never one posted up.
      consentedPolicyVersion: POLICY_VERSION,
      consentedAt: new Date(),
    })
    .where(eq(users.id, userId));
  await recordConsentEvents(userId, ["policy_accepted"], "onboarding");
  await setFirmSharing(userId, shareWithFirms, "onboarding");

  // Drop any AI-matched firms from a previous run through onboarding.
  //
  // Without this the answers appear to do nothing: findTopFirmsForUser only
  // INSERTS firms not already saved (it is the "find more firms" action), so a
  // stale list from earlier answers survives re-onboarding and every new run
  // returns what looks like the same firms. Manually added firms are kept -
  // those are the student's own choices, not a derived result.
  await db
    .delete(userTopFirms)
    .where(and(eq(userTopFirms.userId, userId), eq(userTopFirms.source, "ai_matched")));

  // Match here, on the answers that were just saved, rather than lazily on
  // whichever page the student opens next.
  //
  // Discovery used to run this from its render path: every visit checked
  // whether the list was short and, if so, matched on the spot. That read like
  // a nice piece of laziness and behaved like a loop - a student whose filters
  // are narrow enough that nothing further qualifies never reaches the target,
  // so every page load re-ran the whole match to re-derive the same answer,
  // loading the sector's firms each time. Matching is a write, and writes
  // belong on the event that causes them. This is that event: it is the only
  // moment the answers change, and it is where the student is already waiting.
  //
  // Re-read rather than reusing the values above: matchTopFirmsForUser reads a
  // dozen profile fields, and handing it a half-built object is how it quietly
  // matches against stale preferences.
  const matched = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (matched) {
    try {
      await matchTopFirmsForUser(matched, MATCHED_FIRMS);
    } catch (err) {
      // Best-effort. Finishing onboarding must not fail because matching did -
      // the student can still use "Find more firms" on Opportunities.
      console.error("[onboarding] matching top firms failed", err);
    }
  }

  // A paid account lands on External Network like every login. A free
  // account's first screen after onboarding is the upgrade page - deliberate:
  // this is the one moment the whole product has just been explained, so the
  // choice between living in the community and buying the toolkit is asked
  // once, here, instead of ambushing some later click. Their logins after
  // this land on /networking (login/actions.ts).
  // Straight to the dashboard: the plan pitch that used to sit between here
  // and it is gone with the rest of billing, because every section is open.
  redirect("/dashboard");
}
