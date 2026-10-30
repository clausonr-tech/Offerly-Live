import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, MessageSquare } from "lucide-react";

import ClubLogo from "@/components/ClubLogo";
import LogoAvatar from "@/components/feed/LogoAvatar";
import SampleTag from "@/components/SampleTag";
import { PRESIDENT_TITLES, getClubBySlug, getClubMembers } from "@/lib/clubs";
import { getCurrentUser } from "@/lib/current-user";
import { getFollowing } from "@/lib/follows";
import { externalHref } from "@/lib/safe-url";

import FollowButton from "../../FollowButton";
import { AddMemberBox, LeaveClubButton, RemoveMemberButton } from "../ClubMembershipControls";

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

/** One club: its mark, name and what it does, then everyone in it. */
export default async function ClubPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const club = await getClubBySlug(slug);
  if (!club) notFound();

  const user = await getCurrentUser();
  // Clubs are per school: another school's club page is not this student's.
  const mySchoolId = user.schoolId ?? user.claimedSchoolId ?? null;
  if (!club.schoolId || club.schoolId !== mySchoolId) notFound();
  const [members, following] = await Promise.all([getClubMembers(club.id), getFollowing(user.id)]);
  const me = members.find((m) => m.id === user.id);
  // Membership is the president's to give - see lib/clubs. A member can only leave.
  const isPresident = !!me?.title && PRESIDENT_TITLES.includes(me.title);
  // Officers are listed once, under Leadership - not again under Members.
  const officers = members.filter((m) => m.title);
  const rank = members.filter((m) => !m.title);
  // externalHref, not safeHttpUrl: the clubs INDEX renders the same column
  // through externalHref, and safeHttpUrl checks the scheme and nothing else -
  // so this page accepted a userinfo-disguised host, a bare IP, a private
  // suffix and an odd port that the index refuses. One column, one policy.
  const website = externalHref(club.websiteUrl) ?? null;

  return (
    <div className="max-w-4xl">
      <Link href="/networking/clubs" className="text-xs text-warmgray-500 hover:text-brand-900">
        ← Clubs
      </Link>

      <header className="mt-3 rounded-lg border border-brand-100 bg-white p-6">
        <div className="flex flex-wrap items-start gap-5">
          <ClubLogo name={club.name} size={72} />
          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-brand-900">
              {club.name}
              {club.isSample && <SampleTag title="An example club, not a real organization" />}
            </h1>
            <p className="mt-1 text-sm text-warmgray-500">
              {club.schoolName ?? "Multi-school"} · {members.length} {members.length === 1 ? "member" : "members"}
            </p>
            {club.description && <p className="mt-3 text-sm leading-relaxed text-brand-900">{club.description}</p>}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {me && !isPresident && <LeaveClubButton clubId={club.id} slug={club.slug} />}
              <FollowButton kind="club" id={club.id} following={following.clubs.has(club.id)} />
              {website && (
                <a
                  href={website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-warmgray-500 hover:text-brand-900"
                >
                  Website <ExternalLink size={12} aria-hidden />
                </a>
              )}
            </div>
          </div>
        </div>
      </header>

      {!me && (
        <p className="mt-3 text-xs text-warmgray-500">
          Members are added by the club&apos;s president. Following a club shows its posts in your feed.
        </p>
      )}

      {isPresident && (
        <div className="mt-6">
          <AddMemberBox clubId={club.id} slug={club.slug} />
        </div>
      )}

      {officers.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 text-sm font-semibold text-brand-900">Leadership</h2>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {officers.map((m) => (
              <MemberCard key={m.id} member={m} viewerId={user.id} club={isPresident ? { id: club.id, slug: club.slug } : null} />
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">
          Members <span className="font-normal text-warmgray-500">{rank.length}</span>
        </h2>
        {rank.length === 0 ? (
          <p className="text-sm text-warmgray-500">
            {members.length === 0 ? "No members yet. Be the first to join." : "No other members yet."}
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {rank.map((m) => (
              <MemberCard key={m.id} member={m} viewerId={user.id} club={isPresident ? { id: club.id, slug: club.slug } : null} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function MemberCard({
  member: m,
  viewerId,
  club,
}: {
  member: Awaited<ReturnType<typeof getClubMembers>>[number];
  viewerId: string;
  /** Set only when the viewer is the president: shows a remove control. */
  club: { id: string; slug: string } | null;
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-brand-100 bg-white p-3">
      <LogoAvatar domain={null} label={m.school} initials={initials(m.name)} photoUrl={m.avatarStoragePath} size={36} />
      <div className="min-w-0 flex-1">
        <Link href={`/u/${m.id}`} prefetch={false} className="block truncate text-sm font-medium text-brand-900 hover:underline">
          {m.name}
        </Link>
        <p className="flex items-center gap-1.5 truncate text-xs text-warmgray-500">
          <span className="truncate">
            {m.title ?? "Member"}
            {m.gradYear ? ` · Class of ${m.gradYear}` : ""}
          </span>
          {m.isSample && <SampleTag />}
        </p>
      </div>
      {m.id !== viewerId && (
        <Link
          href={`/messages/${m.id}`}
          prefetch={false}
          aria-label={`Message ${m.name}`}
          title={`Message ${m.name}`}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-brand-200 text-brand-900 transition-colors hover:bg-brand-50"
        >
          <MessageSquare size={14} aria-hidden />
        </Link>
      )}
      {club && m.id !== viewerId && <RemoveMemberButton clubId={club.id} slug={club.slug} userId={m.id} name={m.name} />}
    </li>
  );
}
