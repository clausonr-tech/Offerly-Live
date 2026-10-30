import Link from "next/link";
import { ChevronDown, Sparkles } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { getFinanceNewsByCategory, getMainFinanceNews, getMarketsView, getNewsSettings, getStudentBriefing, getStudentDigest, getStudentFirmTickers, type NewsItem } from "@/lib/finance-news";
import { CATEGORY_LABELS, type FirmProgramCategory } from "@/lib/firm-metadata";
import { getCurrentUserId } from "@/lib/current-user";
import type { Digest } from "@/lib/news/digest";
import type { StudentBriefing } from "@/lib/news/briefing";
import { externalHref } from "@/lib/safe-url";
import EmptyState from "@/components/EmptyState";
import StoryImage from "./StoryImage";
import NewsSourcesPicker from "./NewsSourcesPicker";
import NewsViewSelect from "./NewsViewSelect";
import ReportStory from "./ReportStory";
import StoryPanel, { type StoryPanelStory } from "./StoryPanel";
import MarketBoard from "./MarketBoard";
import MarketsDashboard, { FredNotice, MarketsWrap } from "./MarketsDashboard";

const CATEGORIES = Object.keys(CATEGORY_LABELS) as FirmProgramCategory[];
const VIEW_OPTIONS = [
  { value: "digest", label: "Your digest" },
  { value: "top", label: "Top stories" },
  { value: "markets", label: "Markets" },
  ...CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })),
];

export default async function NewsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; panel?: string }>;
}) {
  const { category: rawCategory, panel: rawPanel } = await searchParams;
  // The Markets view's two tabs: today's overview, or every chart.
  const panel = rawPanel === "charts" ? "charts" : "overview";
  const category = CATEGORIES.includes(rawCategory as FirmProgramCategory)
    ? (rawCategory as FirmProgramCategory)
    : undefined;
  // No query string opens the student's digest; "top" is the old Main tab.
  const view = category ?? (rawCategory === "top" || rawCategory === "markets" ? rawCategory : "digest");

  const userId = await getCurrentUserId();
  // The paid sources this student can read. Not set yet reads as none: the
  // page favors what they can open (src/lib/news/access.ts).
  // The market strip (TradingView's charts), on the digest and the Markets view only.
  const withStrip = rawCategory === "markets" || (!category && rawCategory !== "top");
  // The student's publicly traded top firms lead the board's Wall Street tab.
  const [settings, yourFirms] = await Promise.all([getNewsSettings(userId), withStrip ? getStudentFirmTickers(userId) : Promise.resolve([] as [string, string][])]);
  const access = settings.access ?? [];
  const digest = view === "digest" ? await getStudentDigest(userId) : null;
  const briefing = digest ? await getStudentBriefing(digest.sectors) : null;
  // The digest needs the pipeline; when it is not running, open on the top stories.
  const markets = view === "markets" ? await getMarketsView(access) : null;
  const items =
    markets || (view === "digest" && digest)
      ? []
      : category
        ? await getFinanceNewsByCategory(category, access)
        : await getMainFinanceNews(access);

  const board = withStrip ? <MarketBoard yourFirms={yourFirms} /> : null;

  return (
    <div>
      {/* One slim bar above everything: the title, which view, and the
          student's news sources. */}
      <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border border-accent-200 bg-accent-100 px-5 py-3 shadow-sm">
        <h1 className="text-xl font-semibold text-brand-900">Finance News</h1>
        <NewsViewSelect value={digest || view !== "digest" ? view : "top"} options={VIEW_OPTIONS} />
        <NewsSourcesPicker access={settings.access} school={settings.school} />
      </div>

      {markets ? (
        <MarketsView markets={markets} board={board} panel={panel} />
      ) : digest ? (
        <DigestView digest={digest} briefing={briefing} board={board} />
      ) : items.length === 0 ? (
        <EmptyState>
          Couldn&apos;t load news right now. Try again in a moment.
        </EmptyState>
      ) : (
        <NewsFrontPage items={items} lead={!category} />
      )}
    </div>
  );
}

// The Markets view, in two tabs. Overview: the day's summary, the market
// board across the page, then the markets news. All charts: the heatmap,
// rates, currencies, commodities and the economy - no news.
function MarketsView({ markets, board, panel }: { markets: Awaited<ReturnType<typeof getMarketsView>>; board: React.ReactNode; panel: "overview" | "charts" }) {
  const tab = (key: "overview" | "charts", label: string, href: string) => (
    <Link
      href={href}
      aria-current={panel === key ? "page" : undefined}
      className={`rounded px-4 py-1.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 ${
        panel === key ? "bg-brand-900 text-white" : "text-warmgray-600 hover:bg-brand-50 hover:text-brand-900"
      }`}
    >
      {label}
    </Link>
  );
  return (
    <div className="space-y-8">
      <nav aria-label="Markets" className="flex w-fit gap-1 rounded-md border border-brand-100 bg-white p-1">
        {tab("overview", "Overview", "/news?category=markets")}
        {tab("charts", "All charts", "/news?category=markets&panel=charts")}
      </nav>

      {panel === "charts" ? (
        markets.dashboard ? (
          <MarketsDashboard initial={markets.dashboard} />
        ) : (
          <EmptyState>Market data couldn&apos;t load right now. Try again in a moment.</EmptyState>
        )
      ) : (
        <>
          {markets.wrap ? (
            <MarketsWrap wrap={markets.wrap} />
          ) : (
            <p className="text-sm text-warmgray-500">Today&apos;s market summary is written after 10:30am and again after 4:30pm New York time on trading days.</p>
          )}
          {board}
          {markets.stories.length > 0 && (
            <section aria-label="Markets news">
              <h2 className="mb-3 text-lg font-semibold text-brand-900">Markets news</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {markets.stories.map((item) => (
                  <NewsCard key={item.link} item={item} />
                ))}
              </div>
            </section>
          )}
          {/* The summary can quote FRED's numbers, so its notice goes here too. */}
          <FredNotice />
        </>
      )}
    </div>
  );
}

// The digest: the main story, then the briefing and the market board split
// across the page - briefing on the left, board on the right - then the
// stories. (The owner asked for the split back on 6 October 2026, after a
// day with the board on top and the briefing below it.)
//
// From lg up the board keeps its compact width on the right and sets the
// row's height; the briefing fills exactly that height and scrolls inside it,
// so neither column leaves a blank. Below lg, or once the student expands the
// board across the page, they stack: briefing first (.news-split in
// globals.css drops the columns when the board is wide).
function DigestView({ digest, briefing, board }: { digest: Digest; briefing: StudentBriefing | null; board: React.ReactNode }) {
  const hasStories = digest.sections.some((s) => s.stories.length > 0);
  const split = Boolean(briefing && board);

  return (
    <div className="space-y-8">
      {digest.main && <MainStoryBanner story={digest.main} />}
      {(briefing || board) && (
        <div className={split ? "news-split grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]" : ""}>
          {briefing && (
            <div className={split ? "news-split-briefing max-h-[28rem] overflow-y-auto rounded-lg lg:relative lg:max-h-none lg:min-h-[20rem] lg:overflow-visible" : ""}>
              <div className={split ? "lg:absolute lg:inset-0 lg:overflow-y-auto lg:rounded-lg" : ""}>
                <DailyBriefing briefing={briefing} open />
              </div>
            </div>
          )}
          {board && <div className="news-split-board min-w-0 self-start">{board}</div>}
        </div>
      )}

      {!hasStories && (
        <EmptyState>Nothing matched your interests this morning yet. Check Top stories in the menu above.</EmptyState>
      )}

      {digest.sections.map((section) => (
        <section key={`${section.kind}-${section.title}`} aria-label={section.title}>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold text-brand-900">{section.title}</h2>
            {section.sector && (
              <Link href={`/news?category=${section.sector}`} className="text-xs text-warmgray-600 hover:text-brand-900">
                All {section.title} news →
              </Link>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {section.stories.slice(0, 4).map((story) => (
              <NewsCard key={story.link} item={story} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// The day's main story as a banner: its headline travels across, and the
// whole banner opens the story's panel. The text is rendered twice and the track moves
// exactly half its width, so the loop never jumps (the .marquee-track rule in
// globals.css, shared with the home page). Hovering or focusing pauses it; with
// reduced motion on, it holds still and the headline wraps instead.
function MainStoryBanner({ story }: { story: NewsItem }) {
  const meta = metaLine(story);
  const line = (copy: boolean) => (
    <span className={`flex shrink-0 items-center gap-3 whitespace-nowrap pr-16 ${copy ? "motion-reduce:hidden" : "motion-reduce:whitespace-normal"}`}>
      <span className="text-base font-medium text-white">{story.title}</span>
      <span className="text-sm text-white/60">{meta}</span>
    </span>
  );
  return (
    <StoryPanel
      story={panelStory(story)}
      ariaLabel={`Main story: ${story.title}. ${meta}`}
      className="marquee-pause flex w-full items-stretch overflow-hidden rounded-lg bg-brand-900 text-left focus-within:ring-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
    >
      <span className="flex shrink-0 items-center bg-accent-400 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-white">
        Main story
      </span>
      <span className="relative flex min-w-0 flex-1 items-center overflow-hidden py-3 pl-4" aria-hidden>
        <span className="marquee-track w-max motion-reduce:w-auto" style={{ animationDuration: `${Math.max(18, Math.round((story.title.length + meta.length) / 4))}s` }}>
          {line(false)}
          {line(true)}
        </span>
      </span>
    </StoryPanel>
  );
}

// The day's briefing, closed until the student opens it. A native
// <details>, so it opens with the keyboard and without JavaScript.
function DailyBriefing({ briefing, open }: { briefing: StudentBriefing; open?: boolean }) {
  const written = new Date(briefing.generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return (
    <details open={open} className="group overflow-hidden rounded-lg border border-brand-100 bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-brand-50 [&::-webkit-details-marker]:hidden">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-accent-600">
          <Sparkles size={16} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-brand-900">Today&apos;s briefing</span>
          <span className="block text-xs text-warmgray-500">
            Deals, how markets moved and what it means, the economy and policy
          </span>
        </span>
        <ChevronDown size={16} aria-hidden className="shrink-0 text-warmgray-500 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-brand-100 px-4 py-4">
        {/* Flowing columns, like a newspaper: each section follows the one
            above it, so a short one never leaves a hole beside a long one. */}
        <div className="gap-x-8 lg:columns-2 2xl:columns-3">
          {briefing.sections.map((section) => (
            <section key={section.key} aria-label={section.title} className="mb-5 break-inside-avoid">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-accent-600">{section.title}</h3>
              <ul className="space-y-2">
                {section.bullets.map((b) => (
                  <li key={b.text} className="flex gap-2 text-sm leading-snug text-brand-900">
                    <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400" />
                    <span>
                      {b.text}{" "}
                      {b.sources.filter((src, i, all) => all.findIndex((x) => x.publisher === src.publisher) === i).map((src, i) => {
                        // Read-boundary guard - the citation's link is the feed's
                        // own, not ours (see lib/safe-url). A refused one still
                        // names the publisher, because the claim in the bullet
                        // came from somewhere and the reader is owed that; it
                        // just isn't clickable.
                        const href = externalHref(src.link);
                        return href ? (
                          <a
                            key={src.link}
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={src.title}
                            className="whitespace-nowrap text-xs text-warmgray-500 underline-offset-2 hover:text-brand-900 hover:underline"
                          >
                            {i > 0 && ", "}
                            {src.publisher}
                          </a>
                        ) : (
                          <span key={src.link} title={src.title} className="whitespace-nowrap text-xs text-warmgray-500">
                            {i > 0 && ", "}
                            {src.publisher}
                          </span>
                        );
                      })}
                      {/* A market bullet's numbers come from data, not a story: name the source. */}
                      {b.data?.length ? <span className="whitespace-nowrap text-xs text-warmgray-500">{b.sources.length ? " · " : ""}{b.data.join(", ")}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="mt-4 text-[11px] text-warmgray-500">
          Written by AI at {written} from the stories on this page. Each point links to its source.
        </p>
      </div>
    </details>
  );
}

// Source, age and outlet count, as the panel's top line.
function metaLine(item: NewsItem): string {
  return [item.source, item.publishedAt ? formatDistanceToNow(new Date(item.publishedAt), { addSuffix: true }) : null, item.outlets && item.outlets > 1 ? `${item.outlets} outlets` : null]
    .filter(Boolean)
    .join(" · ");
}

function panelStory(item: NewsItem): StoryPanelStory {
  return {
    title: item.title,
    link: item.link,
    source: item.source,
    meta: metaLine(item),
    locked: Boolean(item.locked ?? item.paywall),
    question: item.question ?? null,
    summary: item.summary ?? null,
  };
}

function Byline({ item }: { item: NewsItem }) {
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-warmgray-500">
      {item.source}
      {/* Only on a paid story this student has not said they can read. */}
      {(item.locked ?? item.paywall) && (
        <span title="Needs a subscription you haven't added under Your news sources" className="rounded-sm bg-brand-50 px-1 text-[10px] font-medium text-warmgray-600">
          Subscriber
        </span>
      )}
      {item.opinion && (
        <span
          title="An opinion or analysis piece about the sector, not a report of an event."
          className="rounded-sm bg-brand-50 px-1 text-[10px] font-medium text-warmgray-600"
        >
          Opinion
        </span>
      )}
      {item.unconfirmed && (
        <span
          title="Reported by one outlet citing unnamed sources, and not yet confirmed by another outlet or a filing."
          className="rounded-sm bg-amber-50 px-1 text-[10px] font-medium text-amber-700"
        >
          Unconfirmed
        </span>
      )}
      {item.publishedAt && <> · {formatDistanceToNow(new Date(item.publishedAt), { addSuffix: true })}</>}
      {/* Several outlets reporting the same event is the best sign it is accurate. */}
      {item.outlets && item.outlets > 1 && <> · {item.outlets} outlets</>}
    </p>
  );
}

// The sector desk's suggested question for a professional, on its top picks.
function AskAbout({ item }: { item: NewsItem }) {
  if (!item.question) return null;
  return (
    <p className="mt-2 border-l-2 border-accent-400 pl-2 text-xs leading-snug text-brand-800">
      <span className="font-medium">Ask about it: </span>
      {item.question}
    </p>
  );
}

// One story's picture: its approved photo, or a firm, sector or masthead tile.
function CardImage({ item, className }: { item: NewsItem; className: string }) {
  return (
    <StoryImage
      imageUrl={item.imageUrl}
      source={item.source}
      sourceDomain={item.sourceDomain}
      sector={item.sector}
      firmName={item.firmName}
      firmDomain={item.firmDomain}
      className={className}
    />
  );
}

// The Report link sits under the card's button rather than inside it: a
// button inside a button is invalid, and a click on it would open the story.
function ReportRow({ item }: { item: NewsItem }) {
  if (!item.id) return null;
  return (
    <div className="flex justify-end px-3 pb-2">
      <ReportStory itemId={item.id} />
    </div>
  );
}

function NewsCard({ item }: { item: NewsItem }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-brand-100 bg-white hover:border-accent-400">
      <StoryPanel story={panelStory(item)} className="flex-1 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500">
        <CardImage item={item} className="aspect-video w-full" />
        <div className="p-3">
          {item.because && (
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-accent-600">{item.because}</p>
          )}
          <p className="text-sm font-medium leading-snug text-brand-900">{item.title}</p>
          <Byline item={item} />
          <AskAbout item={item} />
        </div>
      </StoryPanel>
      <ReportRow item={item} />
    </div>
  );
}

// Picture, then headline, then source and age - the same card everywhere.
// Main additionally promotes the freshest story to a full-width lead.
function NewsFrontPage({ items, lead }: { items: NewsItem[]; lead: boolean }) {
  const [first, ...rest] = items;
  const grid = lead ? rest : items;

  return (
    <div className="space-y-6">
      {lead && first && (
        <div className="overflow-hidden rounded-lg border border-brand-100 bg-white sm:hover:border-accent-400">
          <StoryPanel story={panelStory(first)} className="grid w-full gap-4 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500 sm:grid-cols-2">
            <CardImage item={first} className="aspect-video w-full sm:aspect-auto sm:h-full" />
            <div className="p-5">
              <h2 className="app-hero-title text-2xl font-normal leading-tight text-brand-900">{first.title}</h2>
              <Byline item={first} />
              <AskAbout item={first} />
            </div>
          </StoryPanel>
          <ReportRow item={first} />
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {grid.map((item) => (
          <NewsCard key={item.link} item={item} />
        ))}
      </div>
    </div>
  );
}
