import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { NewsItem } from "@/lib/finance-news";
import { externalHref } from "@/lib/safe-url";
import FirmLogo from "../discovery/FirmLogo";
import OpenTag from "./OpenTag";
import EmptyState from "@/components/EmptyState";

// The sixth panel, and unlike Discovery right before it, this one is not
// decoration - it is the real front page. Every photo, headline and byline
// here is a genuine story from getMainFinanceNews(), the same feed /news
// itself reads. There is no invented description: the underlying feed
// (lib/finance-news.ts) only ever carries a title, not a summary, so the
// caption under each photo IS the real headline - never a fabricated blurb
// standing in for one.
const SHOWN_MAX = 6;

export default function NewsPanel({ items }: { items: NewsItem[] }) {
  // Read-boundary guard, applied before the slice rather than inside the tile:
  // the link comes from a feed nobody here controls (see lib/finance-news), and
  // the whole tile IS the link - a tile that cannot be opened is not a story,
  // it is a dead card. Dropping it first also keeps the strip full and lets
  // the empty-state check below stay the one question it was.
  const shown = items.filter((i) => externalHref(i.link)).slice(0, SHOWN_MAX);

  return (
    // Not one big <Link> around the whole panel like its neighbours: every
    // tile here is ALREADY a real link to a different article, and an anchor
    // cannot nest inside another anchor. Only the title in the corner opens
    // /news; each photo opens its own story.
    <section id="news" className="relative scroll-mt-6">
      <div className="feed-divider relative overflow-hidden border-t bg-surface-1">
        {/* Fades the panel's own lighter surface into the darker page
            background at its left and right edges. */}
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-background to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-background to-transparent" />

        <div className="px-5 pb-12">
            {/* One horizontal strip, the way a newspaper's own front page runs
                its photo stories in a row rather than a grid - and the
                natural shape for a fixed-height panel with a variable number
                of stories. Scrolls sideways rather than wrapping, so it never
                changes the panel's height.
                
                items-center, not the flex default of stretch: the tiles are
                shorter than this box (the box's 270px matches every sibling
                panel's deck height, not the tiles' own natural height), and
                stretching them to fill it would distort the cards rather than
                just leave them room. Centering is what puts equal space above
                the tiles (below the panel's top hairline) and below them
                (above the "News" title sitting in the scrim). */}
            <div className="flex items-center gap-4 overflow-x-auto" style={{ height: 318 }}>
              {shown.length === 0 ? (
                <EmptyStrip />
              ) : (
                shown.map((item) => <NewsTile key={item.link} item={item} />)
              )}
            </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-32 bg-gradient-to-t from-surface-1 via-surface-1/85 to-transparent" />

        <Link
          href="/news"
          aria-label="Open News"
          className="group absolute bottom-6 left-0 z-20 flex items-end gap-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
        >
          <h2 className="ml-[0.02em] text-[8vw] font-bold italic leading-[0.85] tracking-tight text-brand-900 sm:text-4xl lg:text-5xl">
            News
          </h2>
          <OpenTag />
        </Link>
      </div>
    </section>
  );
}

/** One story: a real photo when the feed carried one, a masthead tile when it
 *  didn't (Google News' obfuscated redirect links carry no retrievable
 *  image - see lib/finance-news.ts) - the exact fallback /news itself uses,
 *  so a story never renders as a broken image here either. */
function NewsTile({ item }: { item: NewsItem }) {
  // The same guard the caller filtered on, so this component is safe to render
  // from anywhere and the href below is provably a judged value.
  const href = externalHref(item.link);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex w-52 shrink-0 flex-col overflow-hidden rounded-lg border border-brand-100 bg-white shadow-card transition hover:border-accent-400"
    >
      <div className="aspect-video w-full shrink-0 overflow-hidden bg-brand-50">
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-gradient-to-br from-brand-50 to-brand-100">
            {item.sourceDomain ? (
              <FirmLogo domain={item.sourceDomain} name={item.source || "?"} size={30} />
            ) : (
              <ExternalLink size={18} className="text-warmgray-500" />
            )}
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        {/* The real headline, standing in as the caption - not a summary,
            because the feed does not carry one. */}
        <p className="display-serif line-clamp-3 flex-1 text-[13px] font-bold leading-snug text-brand-900">
          {item.title}
        </p>
        <p className="truncate font-mono text-[9px] uppercase tracking-[0.12em] text-warmgray-500">
          {item.source}
          {item.publishedAt &&
            ` · ${formatDistanceToNow(new Date(item.publishedAt), { addSuffix: true })}`}
        </p>
      </div>
    </a>
  );
}

function EmptyStrip() {
  return (
    <EmptyState className="w-full flex-1">
      <p className="text-sm font-semibold text-brand-900">Couldn&apos;t load news right now</p>
      <p className="mt-1.5 text-xs leading-snug text-warmgray-600">Try again in a moment.</p>
    </EmptyState>
  );
}
