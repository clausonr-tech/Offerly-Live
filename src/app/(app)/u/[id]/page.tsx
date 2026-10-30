import Link from "next/link";
import { notFound } from "next/navigation";
import { BadgeCheck, ExternalLink, MessageSquare } from "lucide-react";
import { format } from "date-fns";
import { getCurrentUserId } from "@/lib/current-user";
import { getPublicProfile } from "@/lib/people";
import { externalHref } from "@/lib/safe-url";
import LogoAvatar from "@/components/feed/LogoAvatar";
import SampleTag from "@/components/SampleTag";

function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const viewerId = await getCurrentUserId();
  const profile = await getPublicProfile(id, viewerId);
  if (!profile) notFound();

  const linkedin = externalHref(profile.linkedinUrl) ?? null;

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/networking"
        className="inline-flex h-11 items-center font-mono text-[11px] uppercase tracking-[0.18em] text-warmgray-500 transition hover:text-brand-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        &larr; Back to Internal Network
      </Link>

      <div className="mt-3 rounded-2xl border border-brand-100 bg-white/50 p-6 sm:p-8">
        <div className="flex flex-wrap items-start gap-5">
          <LogoAvatar
            domain={profile.schoolDomain}
            label={profile.schoolName}
            alt={profile.schoolName ? `${profile.schoolName} crest` : ""}
            initials={initials(profile.name)}
            size={64}
          />

          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-brand-900">
              {profile.name}
              {profile.isSample && <SampleTag />}
            </h1>
            <dl className="mt-2 space-y-1 text-sm text-warmgray-600">
              <div className="flex gap-2">
                <dt className="text-warmgray-500">School</dt>
                <dd className="flex items-center gap-1.5 text-brand-900">
                  {profile.school ?? <span className="text-warmgray-500">Not set</span>}
                  {/* A crest alone cannot say whether the affiliation was
                      proved or just picked from a list, so the profile - the
                      one place with room for it - says which. */}
                  {profile.schoolVerified && (
                    <span
                      title="Verified with a school email"
                      className="inline-flex items-center gap-1 rounded-sm border border-signal-lime/35 bg-signal-lime/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-signal-lime"
                    >
                      <BadgeCheck size={10} aria-hidden="true" />
                      Verified
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-warmgray-500">Class of</dt>
                <dd className="text-brand-900">
                  {profile.gradYear ?? <span className="text-warmgray-500">Not set</span>}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-warmgray-500">Hometown</dt>
                <dd className="text-brand-900">
                  {/* Null covers both "never filled in" and "filled in but the
                      show-on-profile toggle is off" - the viewer can't tell
                      those apart and doesn't need to, so one honest label
                      covers both. */}
                  {profile.hometown ?? <span className="text-warmgray-500">Not shared</span>}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-warmgray-500">Joined</dt>
                <dd>
                  <time dateTime={profile.joinedAt.toISOString()}>
                    {format(profile.joinedAt, "d MMMM yyyy")}
                  </time>
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="mt-6">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-warmgray-500">
            About
          </h2>
          {profile.aboutMe ? (
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-brand-900">
              {profile.aboutMe}
            </p>
          ) : (
            <p className="mt-2 text-sm text-warmgray-500">No bio yet.</p>
          )}
        </div>

        <div className="mt-6">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-warmgray-500">
            Interests
          </h2>
          {profile.interests ? (
            <p className="mt-2 text-sm leading-relaxed text-brand-900">{profile.interests}</p>
          ) : (
            // Same either-way reasoning as Hometown above - null means never
            // filled in or just not shared, and the viewer can't tell which.
            <p className="mt-2 text-sm text-warmgray-500">Not shared.</p>
          )}
        </div>

        <div className="mt-6">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-warmgray-500">
            Past internships
          </h2>
          {profile.internships.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {profile.internships.map((i, idx) => (
                <li key={idx} className="text-sm text-brand-900">
                  <span className="font-medium">{i.role}</span>
                  <span className="text-warmgray-500"> @ {i.firm}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-warmgray-500">No internships listed yet.</p>
          )}
        </div>

        <div className="mt-6">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-warmgray-500">
            Target firms
          </h2>
          {profile.topFirms.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {profile.topFirms.map((firm) => (
                <li
                  key={firm}
                  className="rounded-md border border-brand-100 bg-brand-50/60 px-2.5 py-1 text-xs font-medium text-brand-900"
                >
                  {firm}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-warmgray-500">No target firms yet.</p>
          )}
        </div>

        <div className="mt-7 flex flex-wrap gap-2">
          {!profile.isSelf && (
            <Link
              href={`/messages/${profile.id}`}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-brand-900 px-5 text-sm font-medium text-white transition hover:bg-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              <MessageSquare size={15} aria-hidden="true" />
              Send message
            </Link>
          )}
          {linkedin && (
            <a
              href={linkedin}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-11 items-center gap-2 rounded-full border border-brand-200 px-5 text-sm font-medium text-brand-900 transition hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              LinkedIn
              <ExternalLink size={14} aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
          {profile.isSelf && (
            <Link
              href="/profile"
              className="inline-flex h-11 items-center rounded-full border border-brand-200 px-5 text-sm font-medium text-brand-900 transition hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              Edit your profile
            </Link>
          )}
        </div>

        {profile.isSelf && (
          <p className="mt-4 text-xs leading-relaxed text-warmgray-500">
            This is how your profile looks to everyone else on Offerly.
          </p>
        )}
      </div>
    </div>
  );
}
