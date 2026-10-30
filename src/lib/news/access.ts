// Which paid news sources a student can read, and what that does to their
// News page.
//
// The pipeline collects from paid newsrooms (WSJ, Bloomberg, the FT) because
// that is where much of the important reporting is, and a card always links to
// the publisher. But a page full of stories a student cannot open is a page
// of locked doors. So each student says which paid sources they have - often
// free through their university library - and the page follows:
//
//   - when a paid story they cannot read was also reported by a free outlet,
//     or by one they subscribe to, the card shows that outlet's version;
//   - a story only a paid source they lack has reported moves down the
//     ranking, and only a few such stories are shown (LOCKED_PER_ROW per digest
//     row, LOCKED_SHARE of a sector page) - enough that they still hear about
//     the biggest scoop, never so many that the page is mostly paywall;
//   - until a student says what they have, they are treated as having none.
//
// This file holds no database code, so the picker (a client component) can
// import the list.

export type PaidPublisher = {
  id: string;
  name: string;
  /** Domains whose stories this subscription unlocks. */
  domains: string[];
  /** A domain for the logo. */
  logoDomain: string;
  group: "major" | "trade";
};

export const PAID_PUBLISHERS: PaidPublisher[] = [
  { id: "wsj", name: "The Wall Street Journal", domains: ["wsj.com"], logoDomain: "wsj.com", group: "major" },
  { id: "bloomberg", name: "Bloomberg", domains: ["bloomberg.com"], logoDomain: "bloomberg.com", group: "major" },
  { id: "ft", name: "Financial Times", domains: ["ft.com"], logoDomain: "ft.com", group: "major" },
  { id: "nyt", name: "The New York Times", domains: ["nytimes.com"], logoDomain: "nytimes.com", group: "major" },
  { id: "barrons", name: "Barron's", domains: ["barrons.com"], logoDomain: "barrons.com", group: "major" },
  { id: "fn", name: "Financial News (London)", domains: ["fnlondon.com"], logoDomain: "fnlondon.com", group: "major" },
  {
    id: "pei",
    name: "PEI Media (Private Equity International, Buyouts, VCJ, PDI)",
    domains: ["privateequityinternational.com", "buyoutsinsider.com", "venturecapitaljournal.com", "privatedebtinvestor.com", "infrastructureinvestor.com"],
    logoDomain: "privateequityinternational.com",
    group: "trade",
  },
  { id: "american-banker", name: "American Banker", domains: ["americanbanker.com"], logoDomain: "americanbanker.com", group: "trade" },
  { id: "the-insurer", name: "The Insurer", domains: ["theinsurer.com"], logoDomain: "theinsurer.com", group: "trade" },
  { id: "pi", name: "Pensions & Investments", domains: ["pionline.com"], logoDomain: "pionline.com", group: "trade" },
  { id: "pwm", name: "PWM", domains: ["pwmnet.com"], logoDomain: "pwmnet.com", group: "trade" },
  { id: "bizjournals", name: "The Business Journals", domains: ["bizjournals.com"], logoDomain: "bizjournals.com", group: "trade" },
];

const BY_ID = new Map(PAID_PUBLISHERS.map((p) => [p.id, p]));

export const LOCKED_PER_ROW = 1;
export const LOCKED_SHARE = 0.25;
/** A locked story's score is multiplied by this: it can still lead on a big day, but a free story of similar weight goes first. */
export const LOCKED_PENALTY = 0.5;

export function isPaidPublisherId(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

/** The paid publisher behind a story's domain, or null for a free one. */
export function paidPublisherOf(domain: string | null | undefined): PaidPublisher | null {
  if (!domain) return null;
  const d = domain.toLowerCase().replace(/^www\./, "");
  return PAID_PUBLISHERS.find((p) => p.domains.some((x) => d === x || d.endsWith(`.${x}`))) ?? null;
}

/** Whether a student with these subscriptions can open a story from this domain. Free sources always can. */
export function canRead(domain: string | null | undefined, access: readonly string[]): boolean {
  const paid = paidPublisherOf(domain);
  return !paid || access.includes(paid.id);
}

/**
 * Keep at most `max` locked items, in order: the ones past the limit are
 * dropped, the rest keep their places.
 */
export function capLocked<T>(items: T[], isLocked: (t: T) => boolean, max: number): T[] {
  let seen = 0;
  return items.filter((t) => !isLocked(t) || ++seen <= max);
}
