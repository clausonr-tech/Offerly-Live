import { eq } from "drizzle-orm";
import { findStudentResume } from "@/lib/resume-file";
import { isReadableResume } from "@/lib/resume-formats";
import ResumeSection from "./ResumeSection";
import { getDb } from "@/db/client";
import { schools } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { resolveDriverName } from "@/lib/email";
import { resolveSchoolCrest } from "@/lib/school-crest";
import AccountForm from "./AccountForm";
import ProfilePhoto from "./ProfilePhoto";
import SchoolEmailVerify from "./SchoolEmailVerify";
import PhoneField from "./PhoneField";
import ProfileSection from "./ProfileSection";
import TimeZoneField from "./TimeZoneField";
import { allTimeZones } from "@/lib/time-zone";
import { getTimeZoneSetting } from "@/lib/time-zone-server";
import { CheckCircle2 } from "lucide-react";

/**
 * The Account tab: who you are, then how to reach you, then your record.
 *
 * Identity leads as a header - photo, name, school, year - because it is what
 * the student is looking at when they open their own profile. The account's
 * own settings (login email, password, deleting it) live on the Security tab.
 */
export default async function AccountPage() {
  const user = await getCurrentUser();

  // Read the name from `schools` rather than the denormalised `users.school`
  // so a school renamed in the allowlist shows up here. Separate query instead
  // of a relational `with:` load - those crash PGlite (see lib/auth).
  const db = await getDb();
  // All at once. They were sequential awaits and none of them
  // reads another's result - claimedSchool is the self-reported pick, which is
  // what a student who has not verified an email yet still gets a crest from.
  const [verifiedSchool, claimedSchool, resume, timeZone] = await Promise.all([
    user.schoolId
      ? db.query.schools.findFirst({ where: eq(schools.id, user.schoolId) })
      : Promise.resolve(null),
    user.claimedSchoolId
      ? db.query.schools.findFirst({ where: eq(schools.id, user.claimedSchoolId) })
      : Promise.resolve(null),
    findStudentResume(user.id),
    getTimeZoneSetting(),
  ]);

  // True only in local development with no mail provider: codes are printed to
  // the server log rather than sent, and the verification box says so. The
  // code itself is never shown on the page. resolveDriverName throws in a
  // production deploy with no provider, which is not this case.
  let codesGoToLog = false;
  try {
    codesGoToLog = resolveDriverName() === "console";
  } catch {
    codesGoToLog = false;
  }

  const schoolIsVerified = Boolean(user.schoolEmailVerifiedAt);

  // The crest that stands in for a photo: the verified school wins over the
  // self-reported one, the same order resolveSchoolCrest uses in the feed.
  const crest = resolveSchoolCrest({
    verifiedDomain: verifiedSchool?.emailDomain ?? null,
    verifiedName: verifiedSchool?.name ?? null,
    claimedDomain: claimedSchool?.emailDomain ?? null,
    claimedName: claimedSchool?.name ?? null,
  });
  const displayName = user.name?.trim() || user.email;
  const initials =
    displayName
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?";

  const schoolName = verifiedSchool?.name ?? user.school ?? null;
  const identityLine = [schoolName, user.major, user.gradYear ? `Class of ${user.gradYear}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-6">
      {/* Who you are, first. The photo control keeps its own upload and
          remove buttons; the name and line beside it are read-only here and
          edited in About you below. */}
      <section className="flex flex-wrap items-center gap-5 rounded-lg border border-brand-100 bg-white p-5">
        <ProfilePhoto
          userId={user.id}
          photoVersion={user.avatarStoragePath?.slice(0, 8) ?? null}
          crestDomain={crest?.domain ?? null}
          initials={initials}
          name={displayName}
        />
        <div className="min-w-0">
          <p className="truncate text-xl font-semibold text-brand-900">{displayName}</p>
          {identityLine && <p className="mt-1 text-sm text-warmgray-600">{identityLine}</p>}
          {schoolIsVerified && (
            <p className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-success-700">
              <CheckCircle2 size={13} aria-hidden />
              School email verified
            </p>
          )}
        </div>
      </section>

      <ProfileSection title="About you">
        <AccountForm
          defaultValues={{
            name: user.name,
            school: verifiedSchool?.name ?? user.school,
            major: user.major,
            aboutMe: user.aboutMe,
            showHometownOnProfile: user.showHometownOnProfile,
            showInterestsOnProfile: user.showInterestsOnProfile,
            internships: user.internships ?? [],
          }}
        />
      </ProfileSection>

      <ProfileSection title="Contact and time zone">
        <SchoolEmailVerify
          verifiedEmail={schoolIsVerified ? user.schoolEmail : null}
          // Pending only while a code is out. A school email saved at signup
          // has had no code sent, so it must not open the code step.
          pendingEmail={!schoolIsVerified && user.schoolVerificationCodeHash ? (user.pendingSchoolEmail ?? user.schoolEmail) : null}
          suggestedEmail={user.schoolEmail}
          verifiedSchoolName={verifiedSchool?.name ?? null}
          codesGoToLog={codesGoToLog}
        />
        <PhoneField defaultPhone={user.phone} />
        <TimeZoneField chosen={timeZone.chosen} detected={timeZone.detected} allZones={allTimeZones()} />
      </ProfileSection>

      <ProfileSection title="LinkedIn and resume">
        <ResumeSection
          linkedinUrl={user.linkedinUrl}
          resume={resume ? { filename: resume.filename, readable: isReadableResume(resume.storageKey) } : null}
          readFailed={!user.resumeText}
          studentName={user.name ?? ""}
        />
      </ProfileSection>
    </div>
  );
}
