import { memo } from "react";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import type { FeedItem } from "@/lib/activity";
import PersonMenu from "./PersonMenu";
import FeedPostText from "./FeedPostText";
import EmptyState from "@/components/EmptyState";
import FeedEngagement from "./FeedEngagement";
import FirmLogo from "@/app/(app)/discovery/FirmLogo";

/**
 * The kind chip ("New", "Streak", "Offer", "Post") is deliberately gone.
 *
 * It was a coloured pill on every row restating what the row already said in
 * words underneath it - "Streak" above "Ran 15 in a row in technicals". Four
 * tints competing for attention down a column, all of them redundant. The
 * sentence carries the kind now.
 *
 * The name moved out of that sentence and up beside the avatar, which is the
 * other half of the same change: with a byline at the top of every card, a
 * sentence starting with the same name said it twice.
 */
function Line({ item }: { item: FeedItem }) {
  switch (item.kind) {
    // Each sentence now opens with the verb, because the byline above it has
    // already said who. Capitalised for that reason - these used to be the
    // middle of a sentence that began with a name.
    case "joined":
      return (
        <>
          Joined Offerly
          {item.school ? (
            <>
              {" from "}
              <span className="text-black">{item.school}</span>
            </>
          ) : null}
        </>
      );
    case "streak":
      return (
        <>
          Ran <span className="font-semibold text-black">{item.streak} in a row</span> in technicals
        </>
      );
    case "post":
      // Title and body are both rendered as plain text, never as markup: these
      // are the only strings in this feed a user wrote.
      return (
        <>
          {item.title && <span className="block font-semibold text-black">{item.title}</span>}
          {item.body && (
            <span className={`block whitespace-pre-line text-black ${item.title ? "mt-0.5" : ""}`}>
              {item.body}
            </span>
          )}
        </>
      );
    case "offer":
      return (
        <>
          Got an offer
          {item.role ? (
            <>
              {" - "}
              <span className="text-black">{item.role}</span>
            </>
          ) : null}
          {item.firm ? (
            <>
              {" at "}
              <span className="font-semibold text-black">{item.firm}</span>
            </>
          ) : null}
        </>
      );
  }
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

export function EmptyFeed() {
  return (
    <EmptyState size="lg">
      <p className="text-sm font-semibold text-brand-900">Nothing here yet</p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-warmgray-600">
        This fills up as people hit milestones - joining, running a streak in technicals, landing an
        offer. Yours will show here too.
      </p>
      <Link
        href="/learn"
        className="mt-6 inline-flex h-11 items-center rounded-full bg-brand-900 px-5 text-sm font-medium text-white transition hover:bg-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
      >
        Start a technicals round
      </Link>
    </EmptyState>
  );
}

/**
 * One row of the feed. Shared by the server-rendered list below and the
 * scrolling feed (LiveFeed), which passes `cardRef` to watch what has been on
 * screen.
 */
/**
 * Memoised: the live feed appends a page at a time, and without this every
 * card already on screen re-rendered on each append - measured at 600-700ms
 * of blocked main thread per page once a few hundred were loaded. Items are
 * never mutated in place, so reference equality is exactly "unchanged".
 */
export const FeedCard = memo(function FeedCard({
  item,
  cardRef,
  onDelete,
}: {
  item: FeedItem;
  cardRef?: (el: HTMLLIElement | null) => void;
  /**
   * Takes this row back down. Only ever passed for rows the viewer wrote, and
   * only by the live feed, which owns the confirmation and the optimistic
   * removal (see LiveFeed) - the server-rendered list below passes nothing and
   * renders no control, so no event handler is ever handed to it from a server
   * component. Must be referentially stable, or the memo above stops working.
   */
  onDelete?: (id: string) => void;
}) {
  const who = item.isYou ? "You" : item.name;
  return (
    <li
      ref={cardRef}
      data-feed-id={item.id}
      // content-visibility lets the browser skip layout and paint for cards
      // far off screen - a scrolled feed holds hundreds. The intrinsic size
      // is a placeholder height until a card has been laid out once.
      className="group relative w-full overflow-hidden rounded-[10px] border border-black bg-[#ffffff] [contain-intrinsic-size:auto_260px] [content-visibility:auto] transition duration-200 hover:-translate-y-px hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <div className={`px-4 py-4 ${item.isYou ? "home-mine" : ""}`}>
        {/* The byline: avatar and name on one line, vertically centred
            against each other. items-center rather than items-start,
            which is what actually puts the name "in line with" the
            picture - start-aligned, a single line of text sits against
            the avatar's top edge and reads as floating above it. */}
        <div className="flex items-start gap-3">
          <PersonMenu
            userId={item.userId}
            photoUrl={item.photoUrl}
            name={item.name}
            initials={initials(item.name)}
            schoolDomain={item.schoolDomain}
            schoolName={item.schoolName}
          />

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <p className="min-w-0 truncate text-sm">
                <Link
                  href={`/u/${item.userId}`}
                  className="font-semibold text-black underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
                >
                  {who}
                </Link>
                {/* Only for other people: telling a student their own peer
                    count on their own post is noise. Hidden at zero too - a
                    new account showing "0 peers" beside everything it posts
                    is a worse introduction than showing nothing. */}
                {!item.isYou && item.peerCount > 0 && (
                  <span className="ml-1 font-normal text-warmgray-500">
                    ({item.peerCount} peer{item.peerCount === 1 ? "" : "s"})
                  </span>
                )}
              </p>
              <time
                dateTime={new Date(item.createdAt).toISOString()}
                // Relative time differs by a few seconds between the server
                // render and hydration; the text is allowed to.
                suppressHydrationWarning
                className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-[#45484a]"
              >
                {formatDistanceToNowStrict(new Date(item.createdAt), { addSuffix: true })}
              </time>
              {/* Shown, not revealed on hover. The whole reason this control
                  exists is that something a person published about themselves
                  has to be retractable by them - including an offer announced
                  by a status change they did not realise was public - and a
                  button that only appears to a mouse is not that on a phone. */}
              {item.isYou && onDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(item.id)}
                  aria-label={item.kind === "offer" ? "Remove this offer from the feed" : "Delete this post"}
                  title={item.kind === "offer" ? "Remove this offer from the feed" : "Delete this post"}
                  className="-mr-1 shrink-0 rounded-full p-1 text-[#6b7280] transition hover:bg-[#f3f5f9] hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 motion-reduce:transition-none"
                >
                  <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                </button>
              )}
            </div>
            {/* Their title: a current internship, else major and school. */}
            {item.headline && <p className="truncate text-xs text-[#45484a]">{item.headline}</p>}
            {/* Up to five of their top firms, as logos - who they are
                recruiting for, readable at a glance. Fewer when they have
                picked fewer; nothing when they have none. */}
            {item.firmLogos.length > 0 && (
              <ul aria-label="Top firms" className="mt-1.5 flex items-center gap-1.5">
                {item.firmLogos.map((f) => (
                  <li key={f.website} title={f.name} className="shrink-0">
                    <FirmLogo domain={f.website} name={f.name} size={20} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Content sits below the byline at the card's full width rather
            than indented past the avatar. The feed column is ~520px at
            its widest, and giving an attached image the avatar's width
            back is the difference between a readable screenshot and a
            thumbnail. */}
        <div className="mt-2.5">
          <FeedPostText>
            <Line item={item} />
          </FeedPostText>

          {/* Outside FeedPostText on purpose: that wrapper clamps to
              three lines and measures scrollHeight to decide whether to
              offer "more", and an image inside it would both be cut off
              and corrupt that measurement.

              A plain <img>, not next/image: the route is authenticated
              and per-viewer, so the optimiser would be caching private
              bytes at the edge.

              THE IMAGE IS NEVER RESHAPED - only ever scaled.

              Both axes are capped and both are `auto`, which is what
              makes that true: the browser shrinks the picture until it
              fits inside BOTH bounds and the element's own box ends up
              the size of the scaled picture. No crop, no letterbox, no
              upscaling of something small.

              The distinction that matters, because getting it wrong here
              cost a round already: an earlier version wrote `w-full`
              with `max-h-80` and `object-contain`. `w-full` FORCES the
              width, so the box stopped matching the picture's ratio the
              moment the height cap bit, and object-contain then fitted
              the picture inside that mismatched box with empty bars
              down its sides. Capping is fine; forcing a dimension is
              what breaks it.

              The cap exists because a phone photo is 3024x4032, and
              uncapped that ran 723px down a 520px-wide column - one post
              owning a whole screen of feed. At max-h-96 the same photo
              lands about 306x408, still its own shape. */}
          {item.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.imageUrl}
              alt={item.title ? `Attached to: ${item.title}` : "Attached image"}
              loading="lazy"
              // mx-auto: once a portrait is narrower than the column,
              // left-aligning it leaves a column of dead white down the
              // right that reads as a mistake rather than a margin.
              className="ui-round-md mx-auto mt-2.5 block h-auto max-h-96 w-auto max-w-full border border-[#dfe3ea]"
            />
          )}

          {/* A join post is the closest thing this feed has to an
              introduction, so it carries what the person is actually
              recruiting for rather than just announcing an arrival. */}
          {item.kind === "joined" && item.topFirms.length > 0 && (
            <p className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="sr-only">Targeting</span>
              {item.topFirms.map((firm) => (
                <span
                  key={firm}
                  className="rounded-md border border-[#c5cfe0] bg-[#f3f5f9]/60 px-2 py-0.5 text-[11px] font-medium text-black"
                >
                  {firm}
                </span>
              ))}
            </p>
          )}
        </div>

        <FeedEngagement
          eventId={item.id}
          initialReactions={item.reactions}
          initialCommentCount={item.commentCount}
        />
      </div>
    </li>
  );
});

export default function ActivityFeed({ items }: { items: FeedItem[] }) {
  if (items.length === 0) return <EmptyFeed />;

  return (
    <ul className="flex flex-col items-stretch gap-3">
      {items.map((item) => (
        <FeedCard key={item.id} item={item} />
      ))}
    </ul>
  );
}
