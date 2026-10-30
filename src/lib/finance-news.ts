import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { firms, userTopFirms, users } from "@/db/schema";
import { SHARED_CACHE_SECONDS, SHARED_CACHE_TAGS, sharedCache } from "@/lib/shared-data-cache";
import type { FirmProgramCategory } from "./firm-metadata";
import { pipelineIsLive, readTab } from "./news/read";
import { getDigest, type Digest } from "./news/digest";
import { getBriefing, type StudentBriefing } from "./news/briefing";
import { isSector } from "./news/types";
import type { StorySummary } from "./news/summary";
import { getDashboard, type Dashboard } from "./market-data/board";
import { getMarketWrap, type MarketWrap } from "./news/market-wrap";
import { tickerForWebsite } from "./market-data/firm-tickers";

export type NewsItem = {
  /** The pipeline's id for the story, which the Report link sends. The old feed has none. */
  id?: string;
  title: string;
  link: string;
  source: string;
  sourceDomain: string | null; // for a favicon/masthead icon when there's no photo
  publishedAt: string | null; // ISO string, or null if unparseable
  imageUrl: string | null;
  /** Outlets that reported the same event. Only the news pipeline knows this. */
  outlets?: number;
  paywall?: boolean;
  /** Paid, and not one of this student's subscriptions: the card says "Subscriber". */
  locked?: boolean;
  /** The sector desk's suggested question to ask a professional, on its picks only. */
  question?: string | null;
  /** Reported by one outlet citing unnamed sources, and not yet confirmed. */
  unconfirmed?: boolean;
  /** An opinion or analysis piece about a sector rather than a news report. */
  opinion?: boolean;
  /** In a student's digest: the firm or specialty that put the story there. */
  because?: string | null;
  /** For the tile a card shows when there is no photo: the event's sector and firm. */
  sector?: string | null;
  firmName?: string | null;
  firmDomain?: string | null;
  /** Key points and takeaway for the panel a card opens. Only the news pipeline writes them. */
  summary?: StorySummary | null;
};

// Where the page's stories come from.
//
// The news pipeline (src/lib/news, run on a schedule by scripts/news-run.ts)
// collects from a reviewed list of sources, labels every story with a model and
// ranks events per tab. Reading its result is all the page does now.
//
// Everything below the two exported getters is the page's original live fetch,
// kept as the fallback for one case only: the pipeline is not there. Its
// tables do not exist yet (a database the migration has not reached), or
// nothing has been ranked for three days (the job stopped). A tab that is just
// thin never falls back - it shows its few good stories, because the old feed
// is exactly what the pipeline replaced (21% recall, no quality gates). That
// used to be a per-tab rule, and it quietly handed slow sectors back to the
// old feed; see src/lib/news/read.ts for how thin tabs fill instead.
const PIPELINE_STALE_HOURS = 72;

async function fromPipeline(sector: FirmProgramCategory | null, limit: number, access?: readonly string[]): Promise<NewsItem[] | null> {
  try {
    const db = await getDb();
    if (!(await pipelineIsLive(db, PIPELINE_STALE_HOURS))) return null;
    return await readTab(db, sector, limit, new Date(), access);
  } catch {
    return null;
  }
}

/**
 * The student's morning digest, or null when the pipeline is not running (the
 * page then opens on the top stories instead, from whichever source is up).
 */
export async function getStudentDigest(userId: string): Promise<Digest | null> {
  try {
    const db = await getDb();
    if (!(await pipelineIsLive(db, PIPELINE_STALE_HOURS))) return null;
    return await getDigest(db, userId);
  } catch {
    return null;
  }
}

/**
 * The student's daily briefing: their industries' deals and market moves,
 * then the economy, policy and recruiting. Null when none has been written
 * yet, or the pipeline's tables are not there.
 */
export async function getStudentBriefing(sectors: string[]): Promise<StudentBriefing | null> {
  try {
    const db = await getDb();
    return await getBriefing(db, sectors.filter(isSector));
  } catch {
    return null;
  }
}

/**
 * The paid news sources a student has said they can read (null = never set;
 * the page then assumes none), and their school, for the library reminder.
 */
export async function getNewsSettings(userId: string): Promise<{ access: string[] | null; school: string | null }> {
  try {
    const db = await getDb();
    const [row] = await db.select({ newsAccess: users.newsAccess, school: users.school }).from(users).where(eq(users.id, userId));
    return { access: row?.newsAccess ?? null, school: row?.school ?? null };
  } catch {
    return { access: null, school: null };
  }
}

/**
 * The Markets view: the dashboard (live and official numbers, each with its
 * source), the latest "How markets moved" wrap, and the day's markets stories.
 * Each part is null or empty on its own when it cannot be had, so one source
 * being down never blanks the view.
 */
/**
 * The student's top firms that trade publicly, best match first, as [name,
 * TradingView symbol] - for the market board's Wall Street tab. At most six;
 * empty when none of their firms is listed, or on any error.
 */
export async function getStudentFirmTickers(userId: string): Promise<[string, string][]> {
  try {
    const db = await getDb();
    const rows = await db
      .select({ name: firms.name, website: firms.website })
      .from(userTopFirms)
      .innerJoin(firms, eq(firms.id, userTopFirms.firmId))
      .where(eq(userTopFirms.userId, userId))
      .orderBy(sql`${userTopFirms.matchScore} desc nulls last`, asc(userTopFirms.createdAt));
    const seen = new Set<string>();
    const out: [string, string][] = [];
    for (const r of rows) {
      const symbol = tickerForWebsite(r.website);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      out.push([r.name.replace(/\s*\((?:US|incl\.[^)]*)\)\s*$/i, ""), symbol]);
      if (out.length >= 6) break;
    }
    return out;
  } catch {
    return [];
  }
}

export async function getMarketsView(access?: readonly string[]): Promise<{ dashboard: Dashboard | null; wrap: MarketWrap | null; stories: NewsItem[] }> {
  const [dashboard, rest] = await Promise.all([
    getDashboard().catch(() => null),
    (async () => {
      try {
        const db = await getDb();
        const [wrap, stories] = await Promise.all([getMarketWrap(db).catch(() => null), readTab(db, null, 24, new Date(), access, { storyType: "markets_macro" })]);
        return { wrap, stories };
      } catch {
        return { wrap: null, stories: [] };
      }
    })(),
  ]);
  return { dashboard, ...rest };
}

const cachedMainFinanceNews = sharedCache(
  async (access: string[]) => (await fromPipeline(null, 30, access)) ?? legacyMainFinanceNews(),
  ["finance-news-main-v1"],
  { revalidate: SHARED_CACHE_SECONDS.liveCatalog, tags: [SHARED_CACHE_TAGS.news] },
);

const cachedFinanceNewsByCategory = sharedCache(
  async (category: FirmProgramCategory, access: string[]) =>
    (await fromPipeline(category, 24, access)) ?? legacyFinanceNewsByCategory(category),
  ["finance-news-category-v1"],
  { revalidate: SHARED_CACHE_SECONDS.liveCatalog, tags: [SHARED_CACHE_TAGS.news] },
);

function cacheableAccess(access?: readonly string[]): string[] {
  // Subscription order has no effect on the result. A canonical list keeps
  // each access combination to one cache entry.
  return [...new Set(access ?? [])].sort();
}

export async function getMainFinanceNews(access?: readonly string[]): Promise<NewsItem[]> {
  return cachedMainFinanceNews(cacheableAccess(access));
}

export async function getFinanceNewsByCategory(category: FirmProgramCategory, access?: readonly string[]): Promise<NewsItem[]> {
  return cachedFinanceNewsByCategory(category, cacheableAccess(access));
}

// Google News' public RSS search - no API key required, and by far the best
// source for category-specific relevance (arbitrary search queries). Its
// article links are Google-obfuscated redirects that only resolve via
// client-side JS, though, so we can't pull a real photo for these server-side.
// `when:5d` keeps results recent; queries are quoted phrases where that
// matters for precision (e.g. "private equity" so we don't just match "private").
const CATEGORY_QUERIES: Record<FirmProgramCategory, string> = {
  investment_banking: '"investment banking"',
  private_equity: '"private equity"',
  venture_capital: '"venture capital"',
  private_credit: '"private credit" OR "direct lending"',
  real_estate: "commercial real estate finance",
  hedge_fund: '"hedge fund"',
  sales_trading: "stock market trading Wall Street",
  asset_wealth_management: "asset management wealth management",
  commercial_banking: '"commercial banking" OR "regional bank"',
  insurance: '"insurance industry" OR reinsurance',
  fintech: "fintech payments",
  market_infrastructure: '"stock exchange" OR "clearing house" OR "rating agency"',
  consulting: '"management consulting"',
  other_finance: "corporate finance",
};

// Direct-publisher feeds - unlike Google News these link straight to the
// article and most carry a real photo, which is why every tab can now use the
// same picture-card layout instead of a text list.
//
// Every entry is an institutional/markets desk, not a personal-finance vertical.
// That is the point: this feed exists to give a student something to say in a
// coffee chat, and "7 home expenses that surprise first-time buyers" is not it.
// Each URL below was fetched and confirmed to parse before being added.
const CREDIBLE_FEEDS = [
  { url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", defaultSource: "Barron's", defaultDomain: "barrons.com" },
  { url: "https://finance.yahoo.com/news/rssindex", defaultSource: "Yahoo Finance", defaultDomain: "finance.yahoo.com" },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", defaultSource: "MarketWatch", defaultDomain: "marketwatch.com" },
  { url: "https://fortune.com/feed/fortune-feeds/?id=3230629", defaultSource: "Fortune", defaultDomain: "fortune.com" },
  { url: "https://www.cnbc.com/id/10000664/device/rss/rss.html", defaultSource: "CNBC", defaultDomain: "cnbc.com" },
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", defaultSource: "CNBC", defaultDomain: "cnbc.com" },
  { url: "https://www.pehub.com/feed/", defaultSource: "PE Hub", defaultDomain: "pehub.com" },
];

// Which pooled stories belong to each sector tab. Matched against the headline,
// so these are the words that actually appear in a deal or markets story rather
// than the sector's formal name.
const CATEGORY_MATCHERS: Record<FirmProgramCategory, RegExp> = {
  investment_banking:
    /\b(investment bank|m&a|merger|acquisition|acquire[sd]?|takeover|ipo|initial public offering|deal|advis(?:er|or|ory)|underwrit|goldman|morgan stanley|jpmorgan|jp morgan|citigroup|lazard|evercore|jefferies|rothschild|moelis|perella|centerview|houlihan)\b/i,
  private_equity:
    /\b(private equity|buyout|lbo|leveraged buyout|portfolio company|blackstone|kkr|carlyle|apollo global|tpg|warburg|bain capital|advent|vista equity|thoma bravo|silver lake|general atlantic|dry powder|take-private)\b/i,
  venture_capital:
    /\b(venture capital|vc firm|seed round|series [a-e]\b|startup fundraising|sequoia|andreessen|a16z|benchmark capital|accel|greylock|lightspeed|founders fund|term sheet|valuation round)\b/i,
  private_credit:
    /\b(private credit|direct lending|leveraged loan|unitranche|mezzanine|credit fund|bdc|business development company|ares management|golub|blue owl|hps)\b/i,
  real_estate:
    /\b(real estate|reit|commercial property|office tower|cre |mortgage-backed|property market|landlord|blackstone real estate|data cent(?:er|re))\b/i,
  hedge_fund:
    /\b(hedge fund|short seller|short-sell|activist investor|citadel|bridgewater|millennium|point72|two sigma|renaissance technologies|elliott management|pershing square|quant fund)\b/i,
  sales_trading:
    /\b(trading desk|traders?|equit(?:y|ies) market|bond market|treasur(?:y|ies)|yields?|volatility|s&p 500|nasdaq|dow jones|futures|fx |currency market|commodit)\b/i,
  commercial_banking:
    /\b(commercial bank|regional bank|community bank|deposits?|loan growth|net interest (?:income|margin)|fdic|branch network|small business lending)\b/i,
  insurance:
    /\b(insurer|insurance|reinsur|underwrit(?:er|ing) (?:loss|profit)|premiums?|actuar|catastrophe bond|claims ratio|lloyd's)\b/i,
  fintech:
    /\b(fintech|payments? (?:company|firm|volume)|neobank|digital wallet|stripe|block inc|paypal|klarna|embedded finance|open banking)\b/i,
  market_infrastructure:
    /\b(exchange operator|clearing house|clearinghouse|index provider|rating agency|moody's|s&p global|msci|ice |cme group|nasdaq inc|market data|settlement)\b/i,
  asset_wealth_management:
    /\b(asset manage|wealth manage|blackrock|vanguard|fidelity|state street|pimco|etf|mutual fund|assets under management|aum|private bank)\b/i,
  consulting:
    /\b(consult(?:ing|ancy)|mckinsey|bain & co|boston consulting|bcg|deloitte|accenture|kpmg|pwc|ey )\b/i,
  other_finance:
    /\b(bank|fintech|lend|credit|regulat|federal reserve|fed |sec |earnings|revenue|profit|investor)\b/i,
};

function buildGoogleNewsUrl(query: string) {
  const params = new URLSearchParams({
    q: `${query} when:5d`,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(#\d+|#x[0-9a-fA-F]+|\w+);/g, (match, code: string) => {
      if (code.startsWith("#x")) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return ENTITY_MAP[code] ?? match;
    })
    .trim();
}

function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? decodeEntities(match[1]) : null;
}

function domainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function parseGoogleNewsFeed(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

  for (const block of itemBlocks) {
    const rawTitle = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const sourceMatch = block.match(/<source url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/);
    const source = sourceMatch ? decodeEntities(sourceMatch[2]) : "";
    const sourceDomain = sourceMatch ? domainFromUrl(sourceMatch[1]) : null;
    if (!rawTitle || !link) continue;

    // Google News titles are usually "Headline - Source Name" - strip the
    // trailing source since we already show it separately.
    const title = source && rawTitle.endsWith(` - ${source}`)
      ? rawTitle.slice(0, -(source.length + 3))
      : rawTitle;

    const parsedDate = pubDate ? new Date(pubDate) : null;
    items.push({
      title,
      link,
      source,
      sourceDomain,
      publishedAt: parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
      imageUrl: null,
    });
  }

  return items;
}

// Publishers disagree on where the photo lives: media:content, media:thumbnail,
// an enclosure, or just an <img> inside the description HTML. Checking all four
// is what lets the sector tabs use picture cards instead of a text list.
function extractImage(block: string): string | null {
  const media = block.match(/<media:(?:content|thumbnail)[^>]*\surl="([^"]+)"/);
  if (media) return media[1];

  const enclosure = block.match(/<enclosure[^>]*\surl="([^"]+)"[^>]*type="image/);
  if (enclosure) return enclosure[1];

  const inline = block.match(/<img[^>]*\ssrc=["']([^"']+)["']/);
  if (inline) return decodeEntities(inline[1]);

  return null;
}

function parseDirectFeed(
  xml: string,
  fallback: { defaultSource: string; defaultDomain: string },
): NewsItem[] {
  const items: NewsItem[] = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

  for (const block of itemBlocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const sourceMatch = block.match(/<source url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/);
    const source = sourceMatch ? decodeEntities(sourceMatch[2]) : fallback.defaultSource;
    const sourceDomain = sourceMatch ? domainFromUrl(sourceMatch[1]) : fallback.defaultDomain;
    if (!title || !link) continue;
    const imageUrl = extractImage(block);

    const parsedDate = pubDate ? new Date(pubDate) : null;
    items.push({
      title,
      link,
      source,
      sourceDomain,
      publishedAt: parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
      imageUrl,
    });
  }

  return items;
}

// Filters out first-person advice-column pieces (e.g. MarketWatch's
// "Moneyist" column: "My husband got a $42,000 bonus...", "Can I claim 50%
// of my husband's Social Security...") and personal-finance rate-roundup
// listicles - not the professional/institutional finance news this app is
// for. Detected structurally (headline shape, source label) rather than by
// hardcoding specific bylines, so it holds up as feed content rotates.
const FIRST_PERSON_LEAD_RE = /^(my|our|i'm|i am|i've|i have|i need|i want|can i|should i|do i|we|can we|should we)\b/i;

// An allowlist, not a blocklist.
//
// This started as a blocklist and it did not hold: aggregated feeds and Google
// News pull from a long tail no denylist keeps up with. A live run surfaced a
// bathroom-remodelling press release, a local TV segment, and "Maroon 5 Played
// A Hedge-Fund Guy's Birthday" from a celebrity site - each technically
// matching a finance keyword. Naming who we *do* trust is the only version of
// this that stays correct as feed content rotates.
//
// The bar: an institutional finance or markets desk whose reporting a student
// could actually cite in a coffee chat.
const TRUSTED_DOMAINS = new Set([
  "barrons.com",
  "wsj.com",
  "marketwatch.com",
  "ft.com",
  "reuters.com",
  "bloomberg.com",
  "cnbc.com",
  "fortune.com",
  "economist.com",
  "finance.yahoo.com",
  "nytimes.com",
  "washingtonpost.com",
  "axios.com",
  "businessinsider.com",
  "forbes.com",
  "fnlondon.com",
  "institutionalinvestor.com",
  "pehub.com",
  "buyoutsinsider.com",
  "privateequityinternational.com",
  "privatedebtinvestor.com",
  "hedgeweek.com",
  "efinancialcareers.com",
  "pionline.com",
  "thedeal.com",
  "spglobal.com",
  "morningstar.com",
  "investmentnews.com",
  "americanbanker.com",
  "bankingdive.com",
]);

function isTrustedSource(item: { source: string; sourceDomain: string | null }): boolean {
  const domain = (item.sourceDomain ?? "").toLowerCase().replace(/^www\./, "");
  if (domain) {
    if (TRUSTED_DOMAINS.has(domain)) return true;
    // Accept subdomains of a trusted host (markets.ft.com, www2.cnbc.com).
    for (const trusted of TRUSTED_DOMAINS) {
      if (domain.endsWith("." + trusted)) return true;
    }
    return false;
  }
  // Google News items sometimes carry a publisher name but no usable URL.
  const name = item.source.trim().toLowerCase();
  return [
    "barron's", "barrons", "the wall street journal", "wsj", "marketwatch",
    "financial times", "reuters", "bloomberg", "cnbc", "fortune", "axios",
    "the economist", "yahoo finance", "business insider", "forbes",
    "institutional investor", "pe hub", "pensions & investments",
  ].includes(name);
}

// Consumer money topics. Legitimate journalism, wrong publication for this app:
// none of it is a talking point in a coffee chat with a banker.
const CONSUMER_TOPIC_RE =
  /\b(mortgage rates?|home ?buy|first-time buyer|homeowners?|refinanc|credit cards?|credit score|student loans?|401\(?k\)?|roth ira|social security|medicare|retirement savings|side hustle|budgeting|coupon|grocery|save money|frugal|how much (?:you|i) need|personal loan|car insurance|life insurance|debt payoff)\b/i;

// Paid-wire boilerplate. Securities class-action solicitations and vendor
// announcements syndicate into markets feeds in volume and read as news.
const PRESS_RELEASE_RE =
  /(class action|shareholders? (?:who|with) losses|encourages? .{0,40}investors|law firm|deadline reminder|investigation (?:on behalf|into) |announces? (?:the )?(?:pricing|closing|appointment|launch)|reminds? investors)/i;

// Trusted masthead != finance story. CNBC leads with Middle East strikes and
// Fortune runs education pieces; neither gives a student anything to say to a
// banker. This is the topical gate that source credibility cannot provide.
const FINANCE_SIGNAL_RE =
  /\b(m&a|merger|acquisition|acquire[sd]?|takeover|buyout|lbo|ipo|deal|stake|valuation|investor|investment|fund|capital|private equity|hedge fund|venture|bank(?:s|ing|er)?|lender|credit|debt|bond|yield|treasur|equit(?:y|ies)|stock|share|share ?holder|market|nasdaq|s&p|dow|index|earnings|revenue|profit|loss|guidance|dividend|buyback|federal reserve|the fed|rate cut|rate hike|inflation|recession|sec |regulat|antitrust|filing|prospectus|underwrit|asset manage|wealth manage|etf|portfolio|trading|trader|volatility|commodit|oil price|currency|dollar|fintech|payments|ceo|cfo|chief executive|layoffs?|hiring|bonus|compensation|analyst|consult(?:ing|ancy)|restructur|bankrupt|chapter 11|default|credit rating|downgrade|upgrade)\b/i;

function isUnprofessionalContent(item: {
  title: string;
  source: string;
  sourceDomain?: string | null;
}): boolean {
  if (!isTrustedSource({ source: item.source, sourceDomain: item.sourceDomain ?? null })) return true;

  const normalized = item.title.replace(/[’‘]/g, "'");
  if (CONSUMER_TOPIC_RE.test(normalized)) return true;
  if (PRESS_RELEASE_RE.test(normalized)) return true;
  if (!FINANCE_SIGNAL_RE.test(normalized)) return true;

  const lastColonIdx = normalized.lastIndexOf(":");
  const tail = (lastColonIdx >= 0 ? normalized.slice(lastColonIdx + 1) : normalized).trim();
  return FIRST_PERSON_LEAD_RE.test(tail);
}

function sortByRecency(items: NewsItem[]) {
  items.sort((a, b) => {
    if (!a.publishedAt) return 1;
    if (!b.publishedAt) return -1;
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });
}

async function fetchXml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 1800 }, // 30 min
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Fetches every credible feed once and returns them as one deduplicated pool.
// Both the Main tab and the sector tabs read from this, which is what lets a
// sector tab show real photos - Google News links are obfuscated redirects with
// no retrievable image, so anything sourced from there can only ever be text.
async function getPooledItems(): Promise<NewsItem[][]> {
  const STALE_CUTOFF_MS = 10 * 24 * 60 * 60 * 1000; // 10 days
  const cutoff = Date.now() - STALE_CUTOFF_MS;

  return Promise.all(
    CREDIBLE_FEEDS.map(async (feed) => {
      const xml = await fetchXml(feed.url);
      if (!xml) return [];
      // Some publishers mix stale/evergreen items into their "top stories"
      // feed alongside genuinely fresh ones - drop anything clearly old.
      const items = parseDirectFeed(xml, feed).filter(
        (item) =>
          (!item.publishedAt || new Date(item.publishedAt).getTime() >= cutoff) &&
          !isUnprofessionalContent(item),
      );
      sortByRecency(items);
      return items;
    }),
  );
}

// Interleaves the per-source lists by recency while capping how many slots in a
// row one publisher can take. A pure recency sort let the highest-volume feed
// crowd out everything else; this keeps the true freshest story in the lead
// without letting Yahoo's 50 items bury Barron's 10.
function mergeWithSourceDiversity(feeds: NewsItem[][], limit: number): NewsItem[] {
  const MAX_STREAK = 2;
  const seen = new Set<string>();
  const merged: NewsItem[] = [];
  const pointers = feeds.map(() => 0);
  let lastSourceIndex = -1;
  let streak = 0;

  while (merged.length < limit) {
    const candidates = feeds.map((feed, i) => {
      while (pointers[i] < feed.length && seen.has(feed[pointers[i]].link)) pointers[i]++;
      return pointers[i] < feed.length ? feed[pointers[i]] : null;
    });
    if (candidates.every((c) => c === null)) break;

    const ranked = candidates
      .map((item, i) => ({ item, i }))
      .filter((c): c is { item: NewsItem; i: number } => c.item !== null)
      .sort((a, b) => {
        if (!a.item.publishedAt) return 1;
        if (!b.item.publishedAt) return -1;
        return new Date(b.item.publishedAt).getTime() - new Date(a.item.publishedAt).getTime();
      });

    const pick = streak >= MAX_STREAK ? ranked.find((c) => c.i !== lastSourceIndex) ?? ranked[0] : ranked[0];

    seen.add(pick.item.link);
    merged.push(pick.item);
    pointers[pick.i]++;
    streak = pick.i === lastSourceIndex ? streak + 1 : 1;
    lastSourceIndex = pick.i;
  }

  return merged;
}

async function legacyMainFinanceNews(): Promise<NewsItem[]> {
  const feeds = await getPooledItems();
  return mergeWithSourceDiversity(feeds, 30);
}

// A sector tab is the pool filtered to that sector, so its stories keep their
// photos and their publisher. Google News is only a top-up when the pool is
// thin on a sector - those items have no image, and the card layout falls back
// to a masthead tile for them rather than changing shape.
const MIN_CATEGORY_ITEMS = 8;

async function legacyFinanceNewsByCategory(category: FirmProgramCategory): Promise<NewsItem[]> {
  const feeds = await getPooledItems();
  const matcher = CATEGORY_MATCHERS[category];

  const matchedFeeds = feeds.map((feed) => feed.filter((item) => matcher.test(item.title)));
  const fromPool = mergeWithSourceDiversity(matchedFeeds, 24);
  if (fromPool.length >= MIN_CATEGORY_ITEMS) return fromPool;

  const xml = await fetchXml(buildGoogleNewsUrl(CATEGORY_QUERIES[category]));
  if (!xml) return fromPool;

  const seen = new Set(fromPool.map((i) => i.link));
  const topUp = parseGoogleNewsFeed(xml).filter(
    (item) =>
      !seen.has(item.link) &&
      !isUnprofessionalContent(item) &&
      // The search query alone is too loose - Google returns anything the
      // publisher tagged. Hold top-ups to the same sector test as the pool.
      matcher.test(item.title),
  );
  sortByRecency(topUp);

  return [...fromPool, ...topUp].slice(0, 24);
}

/**
 * What the original keyword rules would have done with one headline: whether it
 * survives the credibility and topic gates, and which sector tabs it matches.
 * Exported only for scripts/news-eval, which scores the new classifier against
 * this as its baseline - the number to beat.
 */
export function legacyLabel(item: { title: string; source: string; sourceDomain: string | null }): {
  relevant: boolean;
  sectors: FirmProgramCategory[];
} {
  const relevant = !isUnprofessionalContent(item);
  const sectors = relevant
    ? (Object.keys(CATEGORY_MATCHERS) as FirmProgramCategory[]).filter((c) => CATEGORY_MATCHERS[c].test(item.title))
    : [];
  return { relevant, sectors };
}
