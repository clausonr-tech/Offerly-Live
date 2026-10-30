import FeedComposer from "./FeedComposer";

/**
 * A rail beside the feed. It scrolls with the page: as the student scrolls the
 * feed, the rails move with it, and once a rail's content has passed it is
 * simply gone, leaving the feed alone in the middle with space either side.
 *
 * It used to be sticky, holding its place with its own scroll area inside
 * (lg:sticky, a viewport-high max-height, overflow-y-auto). That pinned the
 * rails beside the whole feed and made the bottom of each one something to
 * scroll separately; the owner asked for the page to scroll as one on
 * 5 October 2026. The grid stays `items-start`, so a short rail ends where its
 * content does rather than stretching to the feed's height.
 */
function Rail({ className, children }: { className: string; children: React.ReactNode }) {
  return <div className={className}>{children}</div>;
}

/**
 * The Networking hub's three panels, and how they sit.
 *
 * The feed is the middle column and the widest one, because it is the thing
 * that changes: the rails either side are lists the student already owns or
 * could have looked up, and the feed is the only part of the page that is
 * different from one visit to the next.
 *
 * The rails either side are the rest of the social picture: Discussions on
 * the left is what students are asking, Meet Peers on the right is who to
 * know next.
 *
 * Column widths are PROPORTIONAL (`fr`), not fixed rails around a fluid
 * centre, and that is deliberate. The feed has to be the widest column at
 * every size, and rem-based rails cannot promise that here: this app's root
 * font size is 17px, not 16, so every rem is 6.25% larger than its Tailwind
 * class name suggests and `xl` is really 1360px. Rails declared at 17/19rem
 * measured 289/323px and left the feed at 420 - barely wider than a rail.
 * Shares hold whatever the root font size and the sidebar do to the space.
 *
 * The `minmax(0,…)` on all three is load-bearing: a grid track's default
 * `auto` minimum is its content's max-content width, so one long firm name in
 * a rail would widen that column and squeeze the feed - the same class of bug
 * as the missing `grid-cols-1` that blew out this app's mobile layouts.
 *
 * There are three layouts, not two, because the literal left-feed-right
 * arrangement does not fit a laptop. This app's sidebar takes ~300px, so a
 * 1100px screen leaves ~760px of content: split three ways that is a 169px
 * rail, narrow enough that "Declan Larson" clips. So:
 *
 *   < lg            one column, FEED FIRST - on a phone the rails are
 *                   reference material and leading with them pushes the live
 *                   part of the page below the fold.
 *   lg .. xl        two columns: the feed, and the two rails stacked beside
 *                   it. Both rails stay legible instead of both being
 *                   unreadable in the name of symmetry.
 *   xl and up       the real thing - contacts, feed, peers.
 *
 * The middle case is done with explicit row/column placement rather than
 * reordered source, so the same three children serve all three layouts.
 *
 * All three arrive already rendered, as props - this file only decides where
 * they go.
 */
export default function NetworkingHub({
  discussions,
  feed,
  peers,
}: {
  discussions: React.ReactNode;
  feed: React.ReactNode;
  peers: React.ReactNode;
}) {
  return (
    // items-start, or a shorter column stretches to match the tallest one
    // and the rails grow a foot of empty space below their last row.
    // Shares, not widths: at xl the feed takes just under half the row.
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start xl:grid-cols-[minmax(0,0.78fr)_minmax(0,1.55fr)_minmax(0,0.82fr)] xl:gap-8">
      {/* order-* drives the single-column case; col-start/row-start take over
          from lg up. */}
      {/* Below lg the rails are hidden rather than stacked under the feed:
          the feed now loads endlessly (LiveFeed), so anything beneath it
          would be pushed out of reach by every page. Discussions and Peers
          are both a tap away in the tab bar above. */}
      <Rail className="order-2 hidden lg:order-none lg:col-start-2 lg:row-start-1 lg:block xl:col-start-1">{discussions}</Rail>

      <section
        aria-labelledby="community-feed"
        // Spans both rail rows at lg so the feed runs the full height of the
        // column beside it rather than leaving a gap under itself.
        className="order-1 lg:order-none lg:col-start-1 lg:row-start-1 lg:row-span-2 xl:col-start-2 xl:row-span-1"
      >
        {/* h-8 and mb-4, matched by the heading rows in DiscussionsPanel and
            MeetPeersPanel, so all three baselines land together. */}
        <div className="mb-4 flex h-8 items-center gap-2">
          <h2 id="community-feed" className="text-lg font-semibold text-brand-900">
            Feed
          </h2>
          <FeedComposer />
        </div>
        {feed}
      </section>

      <Rail className="order-3 hidden lg:order-none lg:col-start-2 lg:row-start-2 lg:block xl:col-start-3 xl:row-start-1">
        {peers}
      </Rail>
    </div>
  );
}
