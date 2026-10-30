import Link from "next/link";
import { Pencil } from "lucide-react";

import LogoAvatar from "@/components/feed/LogoAvatar";
import { internshipDates } from "@/lib/internships";
import FirmLogo from "../discovery/FirmLogo";

type Internship = {
  firm: string;
  website: string | null;
  role: string;
  start: string | null;
  end: string | null;
  current: boolean;
};

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

/**
 * The top of the Networking feed's left column: the student's own profile as
 * other students see it - photo or crest, name, the title line, About me and
 * internships (current first). A nudge to fill in whatever is still empty,
 * since this is what a peer reads before replying to a message.
 */
export default function ProfilePreviewCard({
  userId,
  name,
  school,
  schoolDomain,
  major,
  gradYear,
  aboutMe,
  internships,
  hasPhoto,
  photoVersion,
}: {
  userId: string;
  name: string;
  school: string | null;
  schoolDomain: string | null;
  major: string | null;
  gradYear: number | null;
  aboutMe: string | null;
  internships: Internship[];
  hasPhoto: boolean;
  photoVersion: string;
}) {
  const title = [major, school ? `${school}${gradYear ? ` '${String(gradYear).slice(-2)}` : ""}` : null]
    .filter(Boolean)
    .join(" · ");
  // Current first, then most recent start.
  const shown = [...internships].sort(
    (a, b) => Number(b.current) - Number(a.current) || (b.start ?? "").localeCompare(a.start ?? ""),
  );

  return (
    <>
      <div className="mb-4 flex h-8 items-center">
        <h2 id="profile-preview" className="text-lg font-semibold text-brand-900">
          Your profile
        </h2>
      </div>

      <section aria-labelledby="profile-preview" className="list-panel mb-8 p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <LogoAvatar
            domain={schoolDomain}
            label={school}
            alt=""
            initials={initials(name)}
            photoUrl={hasPhoto ? `/api/avatar/${userId}?v=${photoVersion}` : null}
            size={52}
          />
          <div className="min-w-0">
            <p className="text-base font-semibold leading-tight text-brand-900">{name}</p>
            {title && <p className="text-xs leading-snug text-warmgray-500">{title}</p>}
          </div>
        </div>

        {aboutMe ? (
          <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-brand-900">{aboutMe}</p>
        ) : (
          <p className="mt-3 text-xs text-warmgray-500">
            No About me yet - it&apos;s the first thing a peer reads.{" "}
            <Link href="/profile" className="underline">
              Add one
            </Link>
          </p>
        )}

        <p className="mb-2 mt-4 font-mono text-[10px] uppercase tracking-[0.16em] text-warmgray-500">Internships</p>
        {shown.length === 0 ? (
          <p className="text-xs text-warmgray-500">
            None added.{" "}
            <Link href="/profile" className="underline">
              Add your internships
            </Link>
          </p>
        ) : (
          <ul className="space-y-2.5">
            {shown.map((it, i) => (
              <li key={`${it.firm}-${i}`} className="flex items-center gap-2.5">
                <FirmLogo domain={it.website ?? ""} name={it.firm} size={28} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-brand-900">
                    {it.role || "Intern"}
                    <span className="font-normal text-warmgray-500"> · {it.firm}</span>
                  </p>
                  <p className="truncate text-xs text-warmgray-500">
                    {internshipDates(it) ?? ""}
                    {it.current && (
                      <span className="ml-1.5 rounded-sm bg-accent-50 px-1 py-px text-[10px] font-medium text-accent-600">Current</span>
                    )}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex items-center gap-3 text-xs">
          <Link href={`/u/${userId}`} prefetch={false} className="font-medium text-brand-900 underline underline-offset-2">
            View as others see it
          </Link>
          <Link href="/profile" className="inline-flex items-center gap-1 text-warmgray-500 hover:text-brand-900">
            <Pencil size={11} aria-hidden />
            Edit
          </Link>
        </div>
      </section>
    </>
  );
}
