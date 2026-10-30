import Link from "next/link";

import EmptyState from "@/components/EmptyState";
import SampleTag from "@/components/SampleTag";
import LogoAvatar from "@/components/feed/LogoAvatar";
import { scoreColor } from "@/components/MatchScore";
import type { RankedPeer } from "@/lib/peer-match";
import type { PeerState } from "@/lib/peers";

import AddPeerButton from "./AddPeerButton";

/**
 * "Meet Peers": students this one has the most in common with.
 *
 * The mirror of the contacts rail on the other side of the feed. That side is
 * industry - people at firms, who are being approached for what they know.
 * This side is the student's own year: people recruiting for the same seats,
 * who are worth knowing precisely because nobody here is a gatekeeper.
 *
 * Every row states WHY it is a row. A similarity list with no reasons reads as
 * an algorithm's opinion and gets ignored; "Also at USC" and "Also targeting
 * Goldman Sachs" are the sentence a student would use to open a message, which
 * is the actual point of putting these people in front of them.
 *
 * Presentational and server-rendered: the page owns the queries, the same way
 * it already does for the feed, so this file is only the shape of the rail.
 */

/** "Alex Morgan" -> "AM" - matches the peers page's own rule. */
function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

function PeerRow({ peer, state }: { peer: RankedPeer; state: PeerState }) {
  const { score, reasons } = peer.peerMatch;

  return (
    <li className="py-3">
      <div className="flex items-start gap-2.5">
        <LogoAvatar
          domain={peer.schoolDomain}
          label={peer.schoolName}
          alt={peer.schoolName ? `${peer.schoolName} crest` : ""}
          initials={initials(peer.name)}
          size={32}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {/* block, not just truncate: Link renders an inline <a>, and
                text-overflow does nothing to an inline box. */}
            <Link
              href={`/u/${peer.id}`}
              prefetch={false}
              className="block min-w-0 flex-1 truncate text-sm font-medium text-brand-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              {peer.name}
            </Link>
            {peer.isSample && <SampleTag />}
            <span
              className="shrink-0 text-xs font-medium tabular-nums"
              style={{ color: scoreColor(score) }}
              title={`${score}% match on the factors your profile can be compared on`}
            >
              {score}
            </span>
          </div>

          <p className="mt-0.5 truncate text-xs text-warmgray-500">
            {peer.schoolName ?? "School not set"}
            {peer.gradYear ? ` · Class of ${peer.gradYear}` : ""}
          </p>
        </div>
      </div>

      {reasons.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-1 pl-[42px] text-[11px] text-accent-600">
          {reasons.slice(0, 2).map((reason) => (
            <span key={reason} className="rounded-sm bg-accent-50 px-1.5 py-0.5 font-medium">
              {reason}
            </span>
          ))}
        </p>
      )}

      <div className="mt-2 flex items-center gap-1.5 pl-[42px]">
        <AddPeerButton userId={peer.id} state={state} />
        <Link
          href={`/messages/${peer.id}`}
          prefetch={false}
          className="inline-flex h-7 items-center rounded-full border border-brand-100 px-2.5 text-xs text-brand-900 transition-colors hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
        >
          Message
        </Link>
      </div>
    </li>
  );
}

export default function MeetPeersPanel({
  peers,
  peerStates,
  /** True when the viewer's own profile has nothing to compare on, which is a
   *  different emptiness from "nobody else is here yet" and needs saying
   *  differently - one is fixed by filling in onboarding, the other by waiting. */
  needsProfile,
}: {
  peers: RankedPeer[];
  peerStates: Map<string, PeerState>;
  needsProfile: boolean;
}) {
  return (
    // Fragment, so the heading is a sibling of the panel and not inside its
    // padding - the same arrangement DiscussionsPanel uses, and the reason all
    // three column headings now sit on one line. The h-8 row height is shared
    // with them so a rail with no button beside its title still lines up.
    <>
      <div className="mb-4 flex h-8 items-center">
        <h2 id="meet-peers" className="text-lg font-semibold text-brand-900">
          Meet Peers
        </h2>
      </div>

      <section aria-labelledby="meet-peers" className="list-panel p-4 sm:p-5">
        <p className="mb-3 text-sm text-warmgray-500">Students closest to your own search.</p>

        {needsProfile ? (
        <EmptyState size="sm">
          Add your school, grad year and target firms in{" "}
          <Link href="/profile" className="underline">
            your profile
          </Link>{" "}
          and we can find students like you.
        </EmptyState>
      ) : peers.length === 0 ? (
        <EmptyState size="sm">
          Nobody else to show yet. This fills in as more students join.
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-brand-100 border-y border-brand-100 shadow-none">
            {peers.map((peer) => (
              <PeerRow key={peer.id} peer={peer} state={peerStates.get(peer.id) ?? "none"} />
            ))}
          </ul>

          <p className="mt-3 text-xs text-warmgray-500">
            Matched equally on target firms, school, sectors, grad year, cities and interests.{" "}
            <Link href="/networking/connect" className="underline">
              Browse everyone
            </Link>
          </p>
          </>
        )}
      </section>
    </>
  );
}
