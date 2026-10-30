import { Suspense } from "react";
import Link from "next/link";
import { Filter, MessageSquare, Search, X } from "lucide-react";
import { asc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { schools } from "@/db/schema";
import {
  getDirectoryMembers,
  getSimilarityProfile,
  rankBySimilarity,
  type DirectoryMember,
  type RankedMember,
} from "@/lib/people";
import { getFollowing, getFollowerCounts } from "@/lib/follows";
import { getPeerCounts, getPeerStates, type PeerState } from "@/lib/peers";
import { getRepresentativeFirmNames } from "@/lib/firms";
import LogoAvatar from "@/components/feed/LogoAvatar";
import AddPeerButton from "./AddPeerButton";
import FollowButton from "./FollowButton";
import PeopleFilters, { type FilterGroup } from "../messages/PeopleFilters";
import EmptyState from "@/components/EmptyState";
import SampleTag from "@/components/SampleTag";

// "firms" (filter by where someone INTERNED) is deliberately gone: that list
// was built from other students' offer-status applications, which is private
// tracker data - see getInternshipsFor in lib/people. The key is still parsed
// below so an old bookmarked URL carrying it still loads the directory
// instead of silently filtering everyone out.
const FILTER_KEYS = ["schools", "gradYears", "topFirms"] as const;

function parseCsv(value: string | undefined): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

/** Every option a filter chip could show, lifted from the old standalone
 *  Connect page unchanged - see its own history there. Each group is a UNION
 *  of a fixed baseline with whatever is actually on someone's profile right
 *  now, so the filters are as real for member five as for member five
 *  thousand, and a member's own values are always selectable even outside
 *  the baseline sample. */
async function buildFilterGroups(members: DirectoryMember[]): Promise<FilterGroup[]> {
  const db = await getDb();
  const [allSchools, representativeFirms] = await Promise.all([
    db.select({ name: schools.name }).from(schools).orderBy(asc(schools.name)),
    getRepresentativeFirmNames(),
  ]);

  const thisYear = new Date().getFullYear();
  const gradYearBaseline = Array.from({ length: 6 }, (_, i) => String(thisYear + i));

  const schoolSet = new Set(allSchools.map((s) => s.name));
  const gradYearSet = new Set(gradYearBaseline);
  const topFirmSet = new Set(representativeFirms);

  for (const m of members) {
    if (m.schoolName) schoolSet.add(m.schoolName);
    if (m.gradYear) gradYearSet.add(String(m.gradYear));
    for (const f of m.topFirms) topFirmSet.add(f);
  }

  return [
    { key: "schools", label: "School", options: [...schoolSet].sort() },
    { key: "gradYears", label: "Grad year", options: [...gradYearSet].sort() },
    { key: "topFirms", label: "Top firms", options: [...topFirmSet].sort() },
  ];
}

function applyFilters(
  members: DirectoryMember[],
  filters: { schools: string[]; gradYears: string[]; topFirms: string[] },
): DirectoryMember[] {
  return members.filter((m) => {
    if (filters.schools.length && !(m.schoolName && filters.schools.includes(m.schoolName))) {
      return false;
    }
    if (filters.gradYears.length && !(m.gradYear && filters.gradYears.includes(String(m.gradYear)))) {
      return false;
    }
    // Multiple selected top firms is an OR, not an AND: "narrow my selection
    // down to people targeting Goldman OR Blackstone" is the useful question.
    if (filters.topFirms.length && !m.topFirms.some((f) => filters.topFirms.includes(f))) {
      return false;
    }
    return true;
  });
}

/** The search box: a name, school or target firm, matched case-insensitively.
 *  Firms someone INTERNED at are not searchable here - that came from their
 *  offer-status applications, which are private (lib/people). */
function matchesQuery(m: DirectoryMember, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [m.name, m.schoolName ?? "", ...m.topFirms].some((v) => v.toLowerCase().includes(q));
}

// The Connect surface, brought inside Community: its own live feed, a
// filterable and similarity-ranked people directory, and a messages inbox,
// as the same three-column layout Connect used when it was its own top-level
// tab. Sits below the "Clubs & firms" section above, which is Community's
// own and has no Connect equivalent.
export default async function PeopleSection({
  viewerId,
  rawFilters,
  query = "",
}: {
  viewerId: string;
  rawFilters: { schools?: string; gradYears?: string; firms?: string; topFirms?: string };
  query?: string;
}) {
  // Sequential rather than Promise.all: PGlite is a single in-process
  // connection and getDirectoryMembers already fans out internally, so there
  // is no parallelism to win here - the queries queue on one connection
  // either way. The directory is a handful of small reads.
  const members = await getDirectoryMembers(viewerId);
  const following = await getFollowing(viewerId);
  const followerCounts = await getFollowerCounts(members.map((m) => m.id));
  // One query for the whole directory, not one per card.
  const peerStates = await getPeerStates(viewerId);
  const peerCounts = await getPeerCounts(members.map((m) => m.id));

  const [viewerProfile, groups] = await Promise.all([
    getSimilarityProfile(viewerId),
    buildFilterGroups(members),
  ]);

  const filters = {
    schools: parseCsv(rawFilters.schools),
    gradYears: parseCsv(rawFilters.gradYears),
    topFirms: parseCsv(rawFilters.topFirms),
  };
  const filtered = applyFilters(members, filters).filter((m) => matchesQuery(m, query));
  // Nearest match to the viewer's own profile first, within whatever the
  // filters above already narrowed down to.
  const ranked = rankBySimilarity(viewerProfile, filtered);

  // The strip under the header: where the viewer stands, at a glance.
  // Requests link to Peers, where they are answered.
  const states = [...peerStates.values()];
  const stats: { label: string; value: number; href?: string }[] = [
    { label: "Members", value: members.length },
    { label: "Your peers", value: states.filter((s) => s === "peers").length, href: "/networking/peers" },
    { label: "Peer requests", value: states.filter((s) => s === "added_you").length, href: "/networking/peers" },
    { label: "Following", value: members.filter((m) => following.users.has(m.id)).length },
  ];

  // Every filter and the search as a removable chip, each linking to the same
  // URL without it.
  const current = { ...rawFilters, q: query || undefined };
  const hrefWithout = (key: keyof typeof current, value: string) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(current)) {
      if (!v) continue;
      const kept = k === key ? v.split(",").filter((x) => x && x !== value).join(",") : v;
      if (kept) next.set(k, kept);
    }
    const qs = next.toString();
    return qs ? `/networking/connect?${qs}` : "/networking/connect";
  };
  const active = [
    ...(query ? [{ key: "q", value: `"${query}"`, removeHref: hrefWithout("q", query) }] : []),
    ...FILTER_KEYS.flatMap((key) =>
      filters[key].map((value) => ({ key, value, removeHref: hrefWithout(key, value) })),
    ),
  ];

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-semibold text-brand-900">Connect</h1>
        <p className="mt-1 max-w-2xl text-sm text-warmgray-500">
          Students on Offerly, closest to your own profile first - same school, class, target firms
          and interests. Add someone as a peer, follow their activity, or message them.
        </p>
      </header>

      <dl className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-brand-100 bg-brand-100 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-white px-4 py-3">
            <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-warmgray-500">{s.label}</dt>
            <dd className="mt-1 text-xl font-semibold text-brand-900">
              {s.href && s.value > 0 ? (
                <Link href={s.href} prefetch={false} className="hover:underline">
                  {s.value}
                </Link>
              ) : (
                s.value
              )}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* A plain GET form: the search is a URL parameter like the filters,
            so a search is shareable and survives a reload. The filters ride
            along as hidden fields so searching doesn't clear them. */}
        <form action="/networking/connect" className="relative min-w-[12rem] flex-1">
          <Search
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-warmgray-500"
          />
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Search by name, school or firm"
            aria-label="Search members"
            className="h-10 w-full rounded-md border border-brand-200 bg-white pl-9 pr-3 text-sm text-brand-900 focus:border-accent-500 focus:outline-none"
          />
          {FILTER_KEYS.map((key) =>
            rawFilters[key] ? <input key={key} type="hidden" name={key} value={rawFilters[key]} /> : null,
          )}
        </form>
        {/* useSearchParams inside PeopleFilters needs a Suspense boundary even
            on a fully dynamic route like this one. */}
        <Suspense
          fallback={
            // Same size as the real button, so the search box doesn't jump
            // when the panel hydrates.
            <span className="inline-flex h-10 bg-white items-center gap-2 rounded-md border border-brand-200 px-3.5 text-sm font-medium text-brand-900">
              <Filter size={15} aria-hidden="true" />
              Filters
            </span>
          }
        >
          <PeopleFilters groups={groups} basePath="/networking/connect" />
        </Suspense>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <p className="mr-1 font-mono text-xs uppercase tracking-[0.16em] text-warmgray-500">
          {filtered.length} of {members.length} {members.length === 1 ? "member" : "members"}
        </p>
        {active.map((chip) => (
          <Link
            key={`${chip.key}:${chip.value}`}
            href={chip.removeHref}
            prefetch={false}
            aria-label={`Remove ${chip.value}`}
            className="inline-flex items-center gap-1 rounded-full border border-accent-500 bg-accent-50 px-2.5 py-0.5 text-xs font-medium text-brand-900 hover:bg-brand-50"
          >
            {chip.value}
            <X size={11} aria-hidden="true" />
          </Link>
        ))}
        {active.length > 1 && (
          <Link
            href="/networking/connect"
            prefetch={false}
            className="ml-1 text-xs text-warmgray-500 underline-offset-2 hover:text-brand-900 hover:underline"
          >
            Clear all
          </Link>
        )}
      </div>

      <MemberList
        members={ranked}
        following={following.users}
        followerCounts={followerCounts}
        peerStates={peerStates}
        peerCounts={peerCounts}
      />
    </div>
  );
}

/** One member's card: school, grad year, target firms and why they were
 *  ranked where they are - the information the standalone Connect page's own
 *  member card carried, less the latest internship, which was read off their
 *  private tracker (lib/people getInternshipsFor) - plus the follow
 *  affordance and follower count Community already had for a person here. */
function MemberList({
  members,
  following,
  followerCounts,
  peerStates,
  peerCounts,
}: {
  members: RankedMember[];
  following: Set<string>;
  followerCounts: Map<string, number>;
  peerStates: Map<string, PeerState>;
  peerCounts: Map<string, number>;
}) {
  if (members.length === 0) {
    return (
      <EmptyState>
        No one matches these filters yet.
      </EmptyState>
    );
  }

  return (
    <ul className="stagger-in grid grid-cols-1 gap-3 lg:grid-cols-2">
      {members.map((member) => {
        const followers = followerCounts.get(member.id) ?? 0;
        const peers = peerCounts.get(member.id) ?? 0;
        return (
          <li
            key={member.id}
            className="rounded-lg border border-brand-100 bg-white p-4 transition hover:border-brand-200"
          >
            <div className="flex items-start gap-3">
              <LogoAvatar
                domain={member.schoolDomain}
                label={member.schoolName}
                alt={member.schoolName ? `${member.schoolName} crest` : ""}
                initials={member.name.trim().charAt(0).toUpperCase() || "?"}
                size={38}
              />
              <div className="min-w-0 flex-1">
                {/* Not prefetched: this directory renders alongside Live feed
                    and Messages, each already running its own query on page
                    load - prefetching every visible card's destination on
                    top of that pushed PGlite's single connection into real,
                    reproducible query failures under the combined load. */}
                <Link
                  href={`/u/${member.id}`}
                  prefetch={false}
                  className="block truncate text-sm font-semibold text-brand-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                >
                  {member.name}
                </Link>
                {member.isSample && (
                  <span className="mt-0.5 inline-block">
                    <SampleTag />
                  </span>
                )}
                <p className="mt-0.5 truncate text-xs text-warmgray-500">
                  {member.schoolName ?? "School not set"}
                  {member.gradYear ? ` · Class of ${member.gradYear}` : ""}
                  {followers > 0 && ` · ${followers} follower${followers === 1 ? "" : "s"}`}
                  {peers > 0 && ` · ${peers} peer${peers === 1 ? "" : "s"}`}
                </p>
              </div>
              {/* Both, side by side. Follow is about reading someone's
                  activity; a peer is mutual and about knowing them. */}
              <div className="flex shrink-0 items-center gap-1.5">
                <AddPeerButton
                  userId={member.id}
                  state={peerStates.get(member.id) ?? "none"}
                />
                <FollowButton kind="user" id={member.id} following={following.has(member.id)} />
              </div>
            </div>

            {member.topFirms.length > 0 && (
              <p className="mt-3 truncate text-[11px] text-warmgray-500">
                Targeting {member.topFirms.slice(0, 2).join(", ")}
                {member.topFirms.length > 2 ? "…" : ""}
              </p>
            )}

            {member.matchReasons.length > 0 && (
              <p className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-accent-600">
                {member.matchReasons.slice(0, 2).map((reason) => (
                  <span key={reason} className="rounded-sm bg-accent-50 px-1.5 py-0.5 font-medium">
                    {reason}
                  </span>
                ))}
              </p>
            )}

            <Link
              href={`/messages/${member.id}`}
              prefetch={false}
              className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-full border border-brand-200 px-3.5 text-xs font-medium text-brand-900 transition hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              <MessageSquare size={13} />
              Message
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
