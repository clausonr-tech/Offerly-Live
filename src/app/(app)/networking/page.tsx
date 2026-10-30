import { getCurrentUser } from "@/lib/current-user";
import { getFeedPage } from "@/lib/activity";
import LiveFeed from "@/components/feed/LiveFeed";
import { getDirectoryMembers, getSimilarityProfile } from "@/lib/people";
import { getPeerStates } from "@/lib/peers";
import { listDiscussions } from "@/lib/discussions";
import { hasScoreableProfile, rankPeerMatches } from "@/lib/peer-match";

import NetworkingHub from "./NetworkingHub";
import MeetPeersPanel from "./MeetPeersPanel";
import DiscussionsPanel, { DISCUSSION_RAIL_SIZE } from "./DiscussionsPanel";
import ProfilePreviewCard from "./ProfilePreviewCard";
import { getPublicProfile } from "@/lib/people";

export const metadata = { title: "Internal Network" };

/** How many suggestions the peers rail leads with. Matched to the
 *  discussions rail so the two sides of the feed are the same weight. */
const PEER_RAIL_SIZE = DISCUSSION_RAIL_SIZE;

/** Firms carried per member for scoring. Higher than the four a member card
 *  displays: overlap is only as honest as the shorter list. */
const FIRMS_FOR_SCORING = 12;

/**
 * Internal Network: what Offerly students are talking about, doing, and who to meet next.
 *
 * The feed in the middle is what is happening; Discussions on the left is the
 * most active threads; Meet Peers on the right is students running the same
 * search. Messages has its own page; Industry Contacts moved to External
 * Network, since they are people at firms rather than Offerly users.
 *
 * The feed is the SAME feed as before: `getFeed` over `activityEvents`,
 * rendered by the same ActivityFeed component. Worth restating, because this
 * route briefly rendered the ORG POSTS feed instead - `posts`, the events and
 * speaker sessions clubs publish. They are unrelated tables: activityEvents is
 * joins, streaks and offers; posts is club programming.
 *
 * Every query goes out at once. They share nothing, and awaiting them in
 * sequence made the page as slow as all of them added together.
 */
export default async function NetworkingPage() {
  const user = await getCurrentUser();
  // The moment this visit opened the feed: what counts as already seen is
  // judged against it for every page of the scroll (lib/activity getFeedPage).
  const snapshot = new Date();

  const [me, threads, feed, members, viewerProfile, peerStates] = await Promise.all([
    getPublicProfile(user.id, user.id),
    listDiscussions(user.id, { limit: DISCUSSION_RAIL_SIZE }),
    getFeedPage(user.id, { snapshot }),
    getDirectoryMembers(user.id, FIRMS_FOR_SCORING),
    getSimilarityProfile(user.id),
    getPeerStates(user.id),
  ]);

  // Already-mutual peers are filtered out rather than ranked down: this rail
  // exists to introduce people, and someone the student has already added is
  // not an introduction. They stay reachable on /networking/peers, which is
  // the page for relationships that already exist.
  const suggestions = rankPeerMatches(viewerProfile, members)
    .filter((peer) => peerStates.get(peer.id) !== "peers")
    .slice(0, PEER_RAIL_SIZE);

  return (
    <div className="space-y-8">
      <NetworkingHub
        discussions={
          <>
            <ProfilePreviewCard
              userId={user.id}
              name={user.name?.trim() || "You"}
              school={me?.schoolName ?? user.school}
              schoolDomain={me?.schoolDomain ?? null}
              major={user.major}
              gradYear={user.gradYear}
              aboutMe={user.aboutMe}
              internships={user.internships ?? []}
              hasPhoto={!!user.avatarStoragePath}
              photoVersion={user.avatarStoragePath?.slice(0, 8) ?? ""}
            />
            <DiscussionsPanel threads={threads} />
          </>
        }
        feed={<LiveFeed initialItems={feed.items} initialCursor={feed.nextCursor} snapshot={snapshot.toISOString()} />}
        peers={
          <MeetPeersPanel
            peers={suggestions}
            peerStates={peerStates}
            needsProfile={!hasScoreableProfile(viewerProfile)}
          />
        }
      />
    </div>
  );
}
