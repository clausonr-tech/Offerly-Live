// Firm metadata that is safe to ship to the browser: the program categories,
// their labels and descriptions, tier names, and the recruiting-timeline
// content the Discovery pages draw from. Small, static, and free of the firm
// directory itself.
//
// Client components import from HERE, never from ./firm-content. That module
// is the full firm catalog (~22.5k firms built from firm-seeds-bulk.json,
// ~5.9MB) and is server-only; importing it from a "use client" file once put a
// 5.1MB chunk on several routes. scripts/test/firm-catalog-client-boundary.test.ts
// fails if any client module can reach the catalog again.

export type FirmProgramCategory =
  | "investment_banking"
  | "private_equity"
  | "venture_capital"
  | "private_credit"
  | "real_estate"
  | "hedge_fund"
  | "sales_trading"
  | "asset_wealth_management"
  | "commercial_banking"
  | "insurance"
  | "fintech"
  | "market_infrastructure"
  | "consulting"
  | "other_finance";

// Only meaningful on firms with an investment_banking program — used to
// power the onboarding "what type of bank appeals to you" follow-up and the
// matching/filtering it feeds.
export type IBTier = "bulge_bracket" | "elite_boutique" | "mid_market";

// Only meaningful on firms with a private_equity program.
export type PETier = "mega_fund" | "middle_market" | "growth_equity" | "venture_capital";

export const IB_TIER_LABELS: Record<IBTier, string> = {
  bulge_bracket: "Bulge Bracket",
  elite_boutique: "Elite Boutique",
  mid_market: "Middle-Market",
};

export const PE_TIER_LABELS: Record<PETier, string> = {
  mega_fund: "Mega-Fund",
  middle_market: "Middle-Market",
  growth_equity: "Growth Equity",
  venture_capital: "Venture Capital",
};

const TIMING_NOTE = "Timing varies by year, school, and office - confirm on the firm's official page before relying on it.";

export const BB_IB_TIMING = `Summer analyst internship applications for bulge-bracket investment banking now open about two summers ahead of the internship - from around August of sophomore year - and most close by February, with interviews running through the winter and spring. Full-time analyst roles are primarily filled through return offers from the summer program, with a smaller number of direct full-time postings later in the cycle. ${TIMING_NOTE}`;

export const BOUTIQUE_IB_TIMING = `Elite boutique advisory firms open earliest of all - many post summer analyst roles from late summer, two summers ahead of the internship, and fill them through the autumn and winter - with full-time hiring mostly through return offers. ${TIMING_NOTE}`;

export const MID_MARKET_IB_TIMING = `Middle-market investment banks generally recruit on a later, less standardized timeline than bulge-bracket and elite-boutique firms - many post internship openings on a rolling basis in the fall for the following summer, and on-campus presence varies a lot by school. Full-time hiring is mostly through return offers, with some direct full-time postings. ${TIMING_NOTE}`;

export const PE_TIMING = `Direct undergraduate hiring into private equity is limited at most firms; the majority of analysts join after 1-2 years in investment banking, recruited on a rapid "on-cycle" or increasingly rolling "off-cycle" basis that varies firm to firm and year to year. Check the firm's site for any direct undergraduate analyst or off-cycle openings. ${TIMING_NOTE}`;

export const RE_SERVICES_TIMING = `Commercial real estate services firms typically run structured graduate/rotational programs with applications opening in the fall for a start the following year, alongside rolling analyst openings by office. ${TIMING_NOTE}`;

export const RE_INVESTING_TIMING = `Real estate investing arms of large alternative asset managers hire on a mix of structured summer analyst programs and rolling experienced hiring; undergraduate direct-hire seats are limited and vary significantly by office. ${TIMING_NOTE}`;

export const HF_TIMING = `Hedge funds vary widely in recruiting structure - some run formal early-career "academy" style programs with applications opening 12-18 months before the start date, others hire on a rolling, as-needed basis with no fixed calendar. ${TIMING_NOTE}`;

export const SALES_TRADING_TIMING = `Sales & trading (markets) summer analyst applications generally open the summer before junior year, later than investment banking now does, and the interview process typically emphasizes trading assessments, market awareness, and quick quantitative reasoning over technical modeling. Full-time roles are primarily filled through return offers. ${TIMING_NOTE}`;

export const AWM_TIMING = `Asset & wealth management summer analyst programs usually open a little later than investment banking, though specific teams (private wealth, portfolio management, client coverage) may recruit separately and on their own timeline. ${TIMING_NOTE}`;

export const CONSULTING_TIMING = `Management and strategy consulting recruits on its own calendar, earlier and more structured than most of finance: summer internship applications for the following summer typically open in the spring or summer beforehand, with first-round interviews in the autumn. The process is built around case interviews rather than technical modelling, usually alongside a behavioural or "personal experience" interview, and many firms run separate sophomore and diversity pipelines. Full-time hiring is largely through return offers. ${TIMING_NOTE}`;

export const OTHER_FINANCE_TIMING = `Recruiting timing at commercial banks, insurance companies, fintech firms, and financial data/exchange companies varies widely - many run structured "early talent" or rotational analyst programs with applications opening in the fall for the following summer or full-time start, while others hire on a rolling, as-needed basis. ${TIMING_NOTE}`;

export const CATEGORY_LABELS: Record<FirmProgramCategory, string> = {
  investment_banking: "Investment Banking",
  private_equity: "Private Equity",
  venture_capital: "Venture Capital",
  private_credit: "Private Credit",
  real_estate: "Real Estate",
  hedge_fund: "Hedge Fund",
  sales_trading: "Sales & Trading",
  asset_wealth_management: "Asset & Wealth Management",
  commercial_banking: "Commercial Banking",
  insurance: "Insurance",
  fintech: "Fintech",
  market_infrastructure: "Market Infrastructure & Data",
  consulting: "Consulting",
  other_finance: "Other Finance",
};

// Beginner-facing "what is this" one-liners for the Discovery section, where
// a student browses by type of finance before knowing much about any of them.
export const CATEGORY_DESCRIPTIONS: Record<FirmProgramCategory, string> = {
  investment_banking:
    "Advising companies on M&A deals and raising capital - the classic gateway into high finance, working in deal teams on financial models and pitch materials.",
  private_equity:
    "Buying, improving, and eventually selling companies for a fund's investors. Most analysts join after a stint in investment banking first.",
  venture_capital:
    "Backing early-stage private companies in exchange for equity. Smaller teams than private equity, far fewer analyst seats, and the work leans toward sourcing and diligence rather than heavy modelling.",
  private_credit:
    "Lending directly to companies instead of buying them - the fastest-growing corner of private markets, sitting between banking and private equity in both the work and the hours.",
  real_estate:
    "Financing, investing in, and managing commercial property - from brokerage and lending to full ownership and development.",
  hedge_fund:
    "Investing pooled capital across markets to generate returns, using strategies ranging from long/short equity to macro and quantitative trading.",
  sales_trading:
    "Executing trades and making markets for institutional clients on a bank's trading floor - fast-paced, with less modeling and more real-time decision-making than banking.",
  asset_wealth_management:
    "Managing money for institutions and individuals - from public-market portfolios to private wealth advising for high-net-worth clients.",
  commercial_banking:
    "Lending to and banking businesses - credit analysis, underwriting and relationship management. Structured training programmes, better hours than banking, and the most common entry point outside a major financial centre.",
  insurance:
    "Underwriting and pricing risk, plus managing the large investment portfolios that back it. Includes carriers, brokers and reinsurers, and is a common home for actuarial and risk-focused students.",
  fintech:
    "Building the software behind payments, lending, trading and banking. Recruits on a tech timeline rather than a finance one, and hires for product, data and engineering alongside finance roles.",
  market_infrastructure:
    "The exchanges, clearing houses, index providers, rating agencies and data vendors the rest of the market runs on - steady, less cyclical work than the deal-driven side of finance.",
  consulting:
    "Advising companies on strategy, operations and turnarounds. Recruits earlier than most of finance, screens on case interviews rather than modelling, and is the most common alternative path students weigh against banking.",
  other_finance:
    "Everything else in finance that does not fit the categories above - corporate finance teams, specialty lenders, and smaller niches.",
};

// A few words each, for the Discovery industry cards, where the full
// descriptions above were clamped mid-sentence ("the classic gateway into
// hi..."). Kept to about 35 characters so each fits on one line of a card at
// four across. The full description still leads each industry's own page.
export const CATEGORY_TAGLINES: Record<FirmProgramCategory, string> = {
  investment_banking: "M&A advice and raising capital",
  private_equity: "Buying, improving and selling companies",
  venture_capital: "Investing in early-stage startups",
  private_credit: "Lending directly to companies",
  real_estate: "Financing and investing in property",
  hedge_fund: "Investing capital across markets",
  sales_trading: "Trading for clients on a bank's floor",
  asset_wealth_management: "Managing money for investors",
  commercial_banking: "Lending to and banking businesses",
  insurance: "Pricing risk and investing premiums",
  fintech: "Software for payments and banking",
  market_infrastructure: "Exchanges, data and credit ratings",
  consulting: "Advising on strategy and operations",
  other_finance: "Corporate finance and niche roles",
};

// Condensed one-line versions of the timingGuidance paragraphs above, for
// compact display (e.g. the Schedule calendar's recruiting-cycle strip).
const CATEGORY_TIMING_SUMMARY: Record<FirmProgramCategory, string> = {
  investment_banking: "Summer analyst apps now open about two summers ahead - from August of sophomore year - and mostly close by February; full-time filled via return offers.",
  private_equity: "Limited direct undergrad hiring - most analysts join after 1-2 years in banking, on-cycle or rolling.",
  venture_capital: "Very few undergrad seats - most funds hire rolling, and many prefer operating or banking experience first.",
  private_credit: "Tracks private equity closely, though a growing number of funds now run their own summer analyst programs.",
  real_estate: "Structured programs open in fall for the next year, plus rolling analyst openings by office.",
  hedge_fund: "Highly variable - some formal programs 12-18 months out, many funds hire rolling as-needed.",
  sales_trading: "Postings open the summer before junior year, later than banking, with trading/markets-focused assessments.",
  asset_wealth_management: "Usually a little later than banking, and specific teams may recruit on their own timeline.",
  commercial_banking: "Structured credit-analyst and rotational programs, applications generally opening in the autumn.",
  insurance: "Actuarial and rotational programs open in the autumn; underwriting teams hire on a rolling basis.",
  fintech: "Runs on a tech calendar - applications from late summer, rolling through the year, with take-home or technical screens.",
  market_infrastructure: "Mostly autumn-opening early-talent programs, with rolling hiring on data and operations teams.",
  consulting: "Its own calendar - applications open spring/summer, first rounds in autumn, screened on cases not models.",
  other_finance: "Varies widely - many run fall-opening early talent programs, others hire on a rolling basis.",
};

export type CategoryTimeline = {
  summary: string; // one-liner
  detail: string; // fuller paragraph, general/default for the category
  byTier?: { label: string; timing: string }[]; // only where sub-tiers genuinely differ (IB)
};

// Recruiting-cycle content for the Discovery category pages: the summary
// above plus the fuller prose already written per program earlier in this
// file, reused here instead of duplicated. IB is the only category where the
// tiers were actually written with distinct timing prose (bulge-bracket vs.
// boutique vs. mid-market recruit on meaningfully different calendars) -
// other categories share one general paragraph regardless of firm size.
export const CATEGORY_TIMELINE: Record<FirmProgramCategory, CategoryTimeline> = {
  investment_banking: {
    summary: CATEGORY_TIMING_SUMMARY.investment_banking,
    detail: BB_IB_TIMING,
    byTier: [
      { label: "Bulge Bracket", timing: BB_IB_TIMING },
      { label: "Elite Boutique", timing: BOUTIQUE_IB_TIMING },
      { label: "Middle-Market", timing: MID_MARKET_IB_TIMING },
    ],
  },
  private_equity: { summary: CATEGORY_TIMING_SUMMARY.private_equity, detail: PE_TIMING },
  venture_capital: { summary: CATEGORY_TIMING_SUMMARY.venture_capital, detail: PE_TIMING },
  private_credit: { summary: CATEGORY_TIMING_SUMMARY.private_credit, detail: PE_TIMING },
  real_estate: { summary: CATEGORY_TIMING_SUMMARY.real_estate, detail: RE_INVESTING_TIMING },
  hedge_fund: { summary: CATEGORY_TIMING_SUMMARY.hedge_fund, detail: HF_TIMING },
  sales_trading: { summary: CATEGORY_TIMING_SUMMARY.sales_trading, detail: SALES_TRADING_TIMING },
  asset_wealth_management: {
    summary: CATEGORY_TIMING_SUMMARY.asset_wealth_management,
    detail: AWM_TIMING,
  },
  commercial_banking: { summary: CATEGORY_TIMING_SUMMARY.commercial_banking, detail: OTHER_FINANCE_TIMING },
  insurance: { summary: CATEGORY_TIMING_SUMMARY.insurance, detail: OTHER_FINANCE_TIMING },
  fintech: { summary: CATEGORY_TIMING_SUMMARY.fintech, detail: OTHER_FINANCE_TIMING },
  market_infrastructure: { summary: CATEGORY_TIMING_SUMMARY.market_infrastructure, detail: OTHER_FINANCE_TIMING },
  consulting: { summary: CATEGORY_TIMING_SUMMARY.consulting, detail: CONSULTING_TIMING },
  other_finance: { summary: CATEGORY_TIMING_SUMMARY.other_finance, detail: OTHER_FINANCE_TIMING },
};

// ---------- visual recruiting timeline ----------
//
// A month-by-month view of the same guidance the prose above describes. The
// windows here are derived from that prose rather than researched separately,
// so the two can't contradict each other - if the prose changes, these move
// with it.
//
// The axis runs January of the year *before* the internship through March of
// the internship year, which is the window essentially all undergraduate
// finance recruiting falls inside. Months 0-11 are Jan-Dec of the recruiting
// year; 12-14 spill into Jan-Mar of the following year.
//
// These are typical patterns, not published dates. Every surface that renders
// them says so - a student who treats a bar as a deadline is worse off than
// one who reads the prose.

// Three letters, not initials: a single-letter axis has three J's, two M's and
// two A's, so a reader cannot tell which month a bar starts in.
export const TIMELINE_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  "Jan", "Feb", "Mar",
] as const;

/** Index at which the axis crosses into the internship year. */
export const TIMELINE_YEAR_BREAK = 12;

/**
 * Months a chart may show BEFORE column 0: July to December two years ahead
 * of the internship. A phase that starts there has a negative start (-6 is
 * July, -1 December). Only a chart with such a phase draws them - see
 * timelineLead - so every other sector's chart is unchanged, and so is the
 * numbering every index above relies on (monitoring/season mirrors it).
 *
 * Added 5 October 2026 for investment banking: the summer-2028 cycle's
 * postings were arriving from August 2026, two summers ahead, and a chart
 * starting in January 2027 told a sophomore it was "a year before this cycle".
 */
export const TIMELINE_LEAD_MONTHS = ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** How many lead months a set of tracks needs drawn: 0 to 6. */
export function timelineLead(tracks: TimelineTrack[]): number {
  const earliest = Math.min(0, ...tracks.flatMap((t) => t.phases.map((p) => p.start)));
  return Math.min(TIMELINE_LEAD_MONTHS.length, Math.max(0, -earliest));
}

/**
 * Where "now" falls on the timeline axis, as a fractional column index, or
 * null when today sits outside the window the axis covers.
 *
 * The axis is relative, not absolute: column 0 is January of the year BEFORE
 * the student's internship, and column 12 is January of the internship year
 * itself. So the same date lands in a different place for a sophomore than for
 * a junior, and the marker has to be derived from their program year rather
 * than from the month alone.
 *
 * The fraction carries the day of the month, so the line sits partway through
 * the current column instead of snapping to its left edge - at a 15-column
 * scale, rounding to whole months would put the marker up to two weeks wrong.
 *
 * Returns null rather than clamping when the student's cycle is already over
 * or has not started: a marker pinned to the edge of the chart would read as
 * "you are here", which would be false.
 */
export type TimelineNowMarker = {
  /** Fractional column index, clamped to the axis. */
  offset: number;
  /** Whether today actually falls inside the window, or sits off one end. */
  status: "in" | "before" | "after";
  /** True when no grad year was set and the cycle had to be assumed. */
  assumed: boolean;
  /**
   * Today as "Sep 2026", computed here rather than in the chart.
   *
   * The chart is a client component and the marker is built on the server; a
   * `new Date()` on both sides can straddle midnight or a timezone and render
   * two different strings, which is a hydration mismatch. One string, computed
   * once, crosses the boundary intact.
   */
  monthLabel: string;
  /**
   * Where the dotted "today" line is drawn: today's own month on the chart.
   * Inside the window it is `offset`. Outside it, the same month of the
   * year on the cycle's first year - September is drawn at September, not
   * pinned to an edge - and `yearsAway` says how far off the cycle really is.
   */
  drawAt: number;
  /** Whole years between today and the chart's cycle: positive when the
   *  cycle is still ahead, negative when it has passed, 0 inside it. */
  yearsAway: number;
};

/**
 * Where "now" sits on the timeline axis, for any student.
 *
 * The axis is relative, not absolute: column 0 is January of the year BEFORE
 * the internship and column 12 is January of the internship year, so the same
 * date lands differently for a sophomore than for a junior.
 *
 * A marker is always returned. When today falls outside the window it is
 * clamped to the nearest edge and `status` says which side it ran off, so the
 * caller can label it honestly rather than implying "you are here" - a senior
 * whose cycle finished should not see a line sitting in the middle of the
 * chart. When no grad year is set the cycle is assumed from today's date
 * (finance recruits roughly 18 months ahead, so the next internship year is
 * the useful default) and `assumed` is set for the caller to disclose.
 */
export function timelineNowMarker(
  programYear: number | null | undefined,
  now: Date,
  /** Lead months the chart draws before column 0 (timelineLead). Offsets are
   *  then counted from the chart's first drawn column. */
  lead = 0,
): TimelineNowMarker {
  const assumed = !programYear;
  // Past March the current year's internships are already filled, so the cycle
  // a student without a grad year is browsing is next year's.
  const effectiveYear = programYear ?? (now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear());

  const axisStartYear = effectiveYear - 1;
  const monthsIn = (now.getFullYear() - axisStartYear) * 12 + now.getMonth();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const raw = monthsIn + (now.getDate() - 1) / daysInMonth;

  const monthLabel = now.toLocaleDateString("en-US", { month: "short", year: "numeric" });

  const max = lead + TIMELINE_MONTHS.length;
  const col = raw + lead;
  // Today's month and day on the chart's first year: the same calendar spot,
  // however many years away the cycle is. The first drawn column is January,
  // or with a lead, the lead's first month.
  const firstMonth = (12 - lead) % 12;
  const sameMonth = ((now.getMonth() - firstMonth + 12) % 12) + (now.getDate() - 1) / daysInMonth;
  if (col < 0) {
    return { offset: 0, status: "before", assumed, monthLabel, drawAt: sameMonth, yearsAway: Math.ceil(-col / 12) };
  }
  // Exclusive upper bound: an offset of exactly the chart's length is
  // 1 April, past the chart rather than its last pixel.
  if (col >= max) {
    return { offset: max, status: "after", assumed, monthLabel, drawAt: sameMonth, yearsAway: -Math.ceil((col - max + 1) / 12) };
  }
  return { offset: col, status: "in", assumed, monthLabel, drawAt: col, yearsAway: 0 };
}

export type TimelinePhaseKind = "apply" | "interview" | "offer" | "rolling";

type TimelinePhase = {
  kind: TimelinePhaseKind;
  label: string;
  /** Inclusive index into TIMELINE_MONTHS. */
  start: number;
  /** Inclusive index into TIMELINE_MONTHS. */
  end: number;
};

export type TimelineTrack = { label: string; phases: TimelinePhase[] };

export const PHASE_LABELS: Record<TimelinePhaseKind, string> = {
  apply: "Applications",
  interview: "Interviews",
  offer: "Offers",
  rolling: "Rolling / varies",
};

// Follows the bulge-bracket pattern: "open in the summer before junior year",
// with earlier sophomore and diversity pipelines ahead of it. Reused by the
// sectors whose prose explicitly says they track the banking cycle.
const IB_CYCLE_TRACK: TimelinePhase[] = [
  { kind: "apply", label: "Sophomore / diversity programs", start: 0, end: 3 },
  { kind: "apply", label: "Summer analyst applications", start: 4, end: 7 },
  { kind: "interview", label: "Interviews", start: 5, end: 9 },
  { kind: "offer", label: "Offers (rolling)", start: 7, end: 10 },
];

export const CATEGORY_TIMELINE_TRACKS: Record<FirmProgramCategory, TimelineTrack[]> = {
  /**
   * Every sector gets real phases, not a hatched "varies" bar.
   *
   * Nine of the fourteen used to be a single `rolling` band reading "teams
   * recruit on their own timelines", which is true of every sector and useful
   * in none: a student opening the insurance page learned nothing they did
   * not already know. `rolling` is now reserved for the cases where the
   * absence of a cycle IS the finding - venture capital's firm postings, and
   * private equity's off-cycle hiring.
   *
   * WINDOWS ARE DELIBERATELY WIDE, and drifting earlier every year. These are
   * the 2025 cycle's observed patterns, and the footer under the chart says
   * so: typical patterns only, confirm real dates on the firm's own page.
   *
   * READING THE INDICES. The axis is TIMELINE_MONTHS: 0-11 are January to
   * December of the year BEFORE the internship, and 12-14 are January to
   * March of the internship year itself. So a window quoted as "Aug-Jan" is
   * 7 to 12, crossing the year break; one quoted "Feb-Aug" is 1 to 7, sitting
   * inside the year before.
   *
   * Investment banking now opens two summers ahead, before column 0: its
   * phases start in the lead months (negative indices, TIMELINE_LEAD_MONTHS).
   * Redrawn 5 October 2026 from the postings themselves: the summer-2028
   * cycle's bulge-bracket and boutique roles were arriving from August 2026,
   * and the old bars, which opened in January of the year before, told a
   * sophomore in October that IB was a year away.
   */
  investment_banking: [
    {
      label: "Bulge Bracket",
      phases: [
        { kind: "apply", label: "Applications open Aug, close by Feb", start: -5, end: 1 },
        { kind: "interview", label: "Interviews", start: -3, end: 3 },
        { kind: "offer", label: "Offers (rolling)", start: -2, end: 5 },
      ],
    },
    {
      label: "Elite Boutique",
      phases: [
        { kind: "apply", label: "Open from late summer, earliest of all", start: -6, end: -1 },
        { kind: "interview", label: "Interviews", start: -4, end: 2 },
        { kind: "offer", label: "Offers", start: -3, end: 3 },
      ],
    },
    {
      label: "Middle-Market",
      phases: [
        { kind: "apply", label: "Postings run through the fall", start: 0, end: 10 },
        { kind: "interview", label: "Interviews", start: 2, end: 8 },
        { kind: "offer", label: "Offers", start: 3, end: 9 },
      ],
    },
  ],

  sales_trading: [
    {
      label: "Markets",
      phases: [
        { kind: "apply", label: "Postings open", start: 7, end: 12 },
        { kind: "interview", label: "Interviews", start: 8, end: 14 },
        { kind: "offer", label: "Offers", start: 10, end: 14 },
      ],
    },
  ],

  private_equity: [
    {
      label: "Undergraduate internships",
      phases: [
        { kind: "apply", label: "Postings open", start: 0, end: 2 },
        { kind: "apply", label: "Some in September", start: 8, end: 8 },
      ],
    },
    {
      label: "On-cycle (associate)",
      phases: [
        // 2024 kicked off on 24 June; the 2025 cycle interviewed on 5 January
        // 2026. A process runs about 72 hours end to end with same-day
        // offers, so interviews and offers are the same window rather than
        // two that follow each other.
        { kind: "interview", label: "Interviews, about 72 hours, same-day offers", start: 5, end: 12 },
      ],
    },
    {
      label: "Off-cycle",
      phases: [{ kind: "rolling", label: "Year-round", start: 0, end: 14 }],
    },
  ],

  real_estate: [
    {
      label: "Brokerage",
      phases: [
        { kind: "apply", label: "Postings open", start: 8, end: 10 },
        { kind: "interview", label: "Interviews", start: 9, end: 11 },
        { kind: "offer", label: "Offers", start: 11, end: 13 },
      ],
    },
    {
      label: "Investment & development",
      phases: [
        { kind: "apply", label: "REIB and REPE postings", start: 11, end: 12 },
        { kind: "interview", label: "Interviews", start: 12, end: 13 },
        { kind: "offer", label: "Offers by spring", start: 13, end: 14 },
      ],
    },
  ],

  hedge_fund: [
    {
      label: "Hedge funds",
      phases: [
        { kind: "apply", label: "Postings open, Jan-Feb most common", start: 7, end: 14 },
        { kind: "interview", label: "Interviews", start: 8, end: 14 },
      ],
    },
  ],

  asset_wealth_management: [
    {
      label: "Asset management",
      phases: [
        { kind: "apply", label: "Postings open", start: 5, end: 14 },
        { kind: "offer", label: "Most hiring done by January", start: 8, end: 12 },
      ],
    },
    {
      label: "Wealth management",
      phases: [{ kind: "apply", label: "Summer roles post Jul-Sep", start: 6, end: 8 }],
    },
  ],

  commercial_banking: [
    {
      label: "Analyst programmes",
      phases: [
        { kind: "apply", label: "Most open Jan-May", start: 0, end: 4 },
        { kind: "rolling", label: "Staggered through the year", start: 0, end: 11 },
      ],
    },
  ],

  insurance: [
    {
      label: "Actuarial & underwriting",
      phases: [
        { kind: "apply", label: "Postings open", start: 6, end: 10 },
        { kind: "interview", label: "Deadlines Sep-Dec, some close by early Oct", start: 8, end: 11 },
      ],
    },
    {
      label: "Later windows",
      phases: [{ kind: "rolling", label: "Some tracks run to April", start: 11, end: 14 }],
    },
  ],

  fintech: [
    {
      label: "Analyst & rotational",
      phases: [
        { kind: "apply", label: "Postings open", start: 7, end: 9 },
        { kind: "interview", label: "Interviews", start: 9, end: 10 },
        { kind: "offer", label: "Positions fill Nov-Dec", start: 10, end: 11 },
      ],
    },
  ],

  market_infrastructure: [
    {
      label: "Exchanges & clearing",
      phases: [
        // DTCC's official window is Aug-Oct and CME's technology roles post
        // Sep-Oct; both sit inside this band.
        { kind: "apply", label: "Postings open", start: 6, end: 9 },
        { kind: "interview", label: "Interviews", start: 9, end: 11 },
      ],
    },
    {
      label: "Later technology tracks",
      phases: [{ kind: "apply", label: "Some post Dec-Apr", start: 11, end: 14 }],
    },
  ],

  consulting: [
    {
      label: "Strategy Consulting",
      phases: [
        // 2025 ran mid-June to mid-July with a second round in early
        // September; 2026 moved earlier, to late March.
        { kind: "apply", label: "Internship deadlines Mar-Sep", start: 2, end: 8 },
        { kind: "interview", label: "First-round case interviews", start: 5, end: 8 },
        { kind: "offer", label: "Offers within days of final rounds", start: 6, end: 9 },
      ],
    },
    {
      label: "Full-time",
      phases: [{ kind: "apply", label: "Deadlines Jul-Sep", start: 6, end: 8 }],
    },
  ],

  private_credit: [
    {
      label: "Analyst & associate",
      phases: [{ kind: "apply", label: "Postings open", start: 1, end: 9 }],
    },
    {
      label: "Off-cycle",
      phases: [{ kind: "rolling", label: "Roles cluster Jun-Aug", start: 5, end: 7 }],
    },
  ],

  venture_capital: [
    {
      label: "Fellowships",
      phases: [
        { kind: "apply", label: "Deadlines", start: 7, end: 8 },
        { kind: "apply", label: "Second wave", start: 11, end: 12 },
        { kind: "interview", label: "Interviews", start: 12, end: 12 },
      ],
    },
    {
      label: "Firm postings",
      phases: [{ kind: "rolling", label: "No standard cycle - year-round", start: 0, end: 14 }],
    },
  ],

  other_finance: [
    {
      label: "Big 4 advisory & restructuring",
      phases: [
        { kind: "apply", label: "Postings open", start: 7, end: 11 },
        { kind: "interview", label: "Rolling closes", start: 8, end: 12 },
        { kind: "offer", label: "Offers", start: 9, end: 12 },
      ],
    },
  ],
};
