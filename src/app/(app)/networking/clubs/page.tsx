import { sql, eq } from "drizzle-orm";
import { ExternalLink } from "lucide-react";
import { getDb } from "@/db/client";
import { clubs, posts, schools } from "@/db/schema";
import { getCurrentUser } from "@/lib/current-user";
import { getFollowing } from "@/lib/follows";
import FollowButton from "../FollowButton";
import Link from "next/link";

import ClubLogo from "@/components/ClubLogo";
import EmptyState from "@/components/EmptyState";
import SampleTag from "@/components/SampleTag";
import { getMemberCounts, getMyClubIds } from "@/lib/clubs";
import { externalHref } from "@/lib/safe-url";

/**
 * Clubs: the ones this student is actually in, then the ones they could join.
 * Each card opens the club's page (/networking/clubs/[slug]) - its mark,
 * description and full member list.
 *
 * "Your clubs" is membership only (club_members). A club's president adds
 * its members; following a club - which puts its posts in the feed - never
 * makes anyone a member, and neither does a club name typed into onboarding.
 */

export default async function ClubsPage() {
  const user = await getCurrentUser();
  const db = await getDb();

  // Post counts in one grouped query rather than per club - the alternative is
  // a query per row, which is how a directory turns into forty round trips on
  // a single in-process connection.
  const counts = new Map(
    (
      await db
        .select({ clubId: posts.clubId, n: sql<number>`count(*)::int` })
        .from(posts)
        .groupBy(posts.clubId)
    )
      .filter((r) => r.clubId)
      .map((r) => [r.clubId as string, Number(r.n)]),
  );

  // A student sees their own school's clubs and no one else's.
  const mySchoolId = user.schoolId ?? user.claimedSchoolId ?? null;
  const rows = !mySchoolId
    ? []
    : await db
    .select({
      id: clubs.id,
      slug: clubs.slug,
      isSample: clubs.isSample,
      name: clubs.name,
      description: clubs.description,
      websiteUrl: clubs.websiteUrl,
      schoolId: clubs.schoolId,
      schoolName: schools.name,
    })
    .from(clubs)
    .leftJoin(schools, eq(clubs.schoolId, schools.id))
    .where(eq(clubs.schoolId, mySchoolId))
    .orderBy(clubs.name);

  const following = await getFollowing(user.id);
  const [memberCounts, myClubs] = await Promise.all([getMemberCounts(rows.map((r) => r.id)), getMyClubIds(user.id)]);

  const mine = rows
    .map((c) => ({
      ...c,
      followed: following.clubs.has(c.id),
      joined: myClubs.has(c.id),
    }))
    // Membership only. Following a club is not joining it, and neither is a
    // name typed into onboarding - the president adds members.
    .filter((c) => c.joined);

  // Everything else at their school, most active first.
  const mineIds = new Set(mine.map((c) => c.id));
  const rest = rows
    .filter((c) => !mineIds.has(c.id))
    .sort((a, b) => {
      const school = Number(b.schoolId === mySchoolId) - Number(a.schoolId === mySchoolId);
      if (school !== 0) return school;
      const active =
        (counts.get(b.id) ?? 0) + (memberCounts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) - (memberCounts.get(a.id) ?? 0);
      if (active !== 0) return active;
      return a.name.localeCompare(b.name);
    });

  return (
    <div className="space-y-8">
      <Section
        label="Your clubs"
        count={mine.length}
        empty={
          !mySchoolId
            ? "Add your school in your profile to see its clubs."
            : rows.length === 0
            ? "No clubs at your school yet. Once a club account is verified it shows up here, and its events appear in the feed."
            : "None yet. A club's president adds its members. Following a club shows its posts in your feed."
        }
      >
        {mine.map((c) => (
          <ClubCard
            key={c.id}
            club={c}
            posts={counts.get(c.id) ?? 0}
            members={memberCounts.get(c.id) ?? 0}
            isMySchool={!!c.schoolId && c.schoolId === mySchoolId}
            following={c.followed}
            note="Member"
          />
        ))}
      </Section>

      {rest.length > 0 && (
        <Section label="Find clubs" count={rest.length} empty="">
          {rest.map((c) => (
            <ClubCard
              key={c.id}
              club={c}
              posts={counts.get(c.id) ?? 0}
              members={memberCounts.get(c.id) ?? 0}
              isMySchool={!!c.schoolId && c.schoolId === mySchoolId}
              following={following.clubs.has(c.id)}
              note={null}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  label,
  count,
  empty,
  children,
}: {
  label: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-brand-900">
        {label}
        <span className="ml-1.5 font-sans tracking-normal text-warmgray-500">{count}</span>
      </p>
      {count === 0 ? (
        <EmptyState size="sm">
          {empty}
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">{children}</ul>
      )}
    </section>
  );
}

function ClubCard({
  club,
  posts: postCount,
  members,
  isMySchool,
  following,
  note,
}: {
  club: {
    id: string;
    slug: string;
    isSample: boolean;
    name: string;
    description: string | null;
    websiteUrl: string | null;
    schoolName: string | null;
  };
  posts: number;
  members: number;
  isMySchool: boolean;
  following: boolean;
  note: string | null;
}) {
  return (
    <li className="list-panel flex min-w-0 flex-col border border-brand-100 p-4">
      <div className="flex items-start justify-between gap-3">
        <ClubLogo name={club.name} size={40} />
        <div className="min-w-0 flex-1">
          <Link
            href={`/networking/clubs/${club.slug}`}
            prefetch={false}
            className="line-clamp-2 text-sm font-medium text-brand-900 hover:underline"
          >
            {club.name}
          </Link>
          <p className="mt-0.5 truncate text-xs text-warmgray-500">
            {club.schoolName ?? "Multi-school"}
            {isMySchool ? " · your school" : ""}
            {note ? ` · ${note}` : ""}
          </p>
        </div>
        <FollowButton kind="club" id={club.id} following={following} />
      </div>

      {club.description && (
        <p className="mt-3 line-clamp-3 text-sm text-warmgray-500">{club.description}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-xs">
        {/* Plain text, not a link, and deliberately so.
            It used to point at /feed?org=club:<id>, which worked while Home
            rendered the org POSTS feed and could be filtered to one club. Home
            is the live activity feed now, so that URL would quietly ignore the
            org parameter and drop the reader on an unfiltered list - a link
            that goes somewhere wrong is worse than a number that goes nowhere.
            Restore the link the moment club posts have a surface again. */}
        <span className="text-warmgray-500">
          {members} {members === 1 ? "member" : "members"}
        </span>
        {club.isSample && <SampleTag title="An example club, not a real organization" />}
        <span className="text-warmgray-500">
          {postCount === 0 ? "No posts yet" : `${postCount} ${postCount === 1 ? "post" : "posts"}`}
        </span>
        {externalHref(club.websiteUrl) && (
          <a
            // Read-boundary guard: a club's website is stored data, and React
            // neutralises only `javascript:`. See lib/safe-url.
            href={externalHref(club.websiteUrl)!}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-warmgray-500 hover:text-brand-900"
          >
            Website
            <ExternalLink size={12} className="shrink-0" />
          </a>
        )}
      </div>
    </li>
  );
}
