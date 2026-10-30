import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { schools } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import VerifySchoolStep from "./VerifySchoolStep";

/**
 * The onboarding checkpoint: confirm the school you just picked.
 *
 * Sits between the links step and the question wizard, so a student's school
 * is proven before any of the answers that hang off it are collected.
 *
 * Skippable, deliberately. A hard gate here strands every student who cannot
 * reach their school inbox during signup - the ones who have not been issued
 * an address yet, who are between schools, or who are simply on a phone - and
 * a signup that cannot be completed is worse than an unverified school. The
 * picked school still drives matching in the meantime; verification is what
 * turns it from a claim into a fact, and the profile keeps asking.
 */
export default async function VerifySchoolPage() {
  const user = await getCurrentUser();

  // Nothing to confirm if they never picked one - send them on rather than
  // showing a step about a school that does not exist.
  if (!user.claimedSchoolId && !user.schoolId) redirect("/onboarding");
  if (user.schoolEmailVerifiedAt) redirect("/onboarding");

  const db = await getDb();
  const picked = await db.query.schools.findFirst({
    where: eq(schools.id, user.schoolId ?? user.claimedSchoolId!),
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <VerifySchoolStep
        schoolName={picked?.name ?? "your school"}
        schoolDomain={picked?.emailDomain ?? null}
        defaultEmail={user.pendingSchoolEmail ?? user.schoolEmail}
      />
    </div>
  );
}
