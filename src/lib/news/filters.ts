import { createHash } from "node:crypto";
import { findBlockedLanguage } from "../content-limits";
import { BLOCKED_DOMAINS } from "./sources";
import type { RawItem } from "./types";

// Everything that can be decided without a model, run before one is paid for.
// The regexes here are the survivors of finance-news.ts: the ones that caught
// real junk in live runs. The sector matchers and the finance-word gate did
// not survive - they are exactly what the classifier replaces (the gate
// dropped "Swiss Re renews Florida programme" for lacking a generic finance
// word, and the IB matcher took any headline containing "deal").

export const MAX_AGE_HOURS = 72;
// Regulators publish a few releases a week, and a rule or an enforcement action
// is still worth knowing on day five. Everything else is news for three days.
export const REGULATOR_MAX_AGE_HOURS = 7 * 24;
const DESCRIPTION_LIMIT = 400;

// Personal-finance ADVICE: headlines written to an individual reader about
// their own money. Only the advice shape is dropped here - consumer-finance
// NEWS about an industry (credit-card delinquencies, mortgage lending, a bank's
// fees, insurers raising premiums) is kept for the classifier to place, which
// the owner asked for on 29 September 2026. The earlier version of this list
// dropped any headline that mentioned credit cards, mortgage rates or car
// insurance, and with them real banking and insurance news.
const CONSUMER_TOPIC_RE =
  /\b(should you|how to (?:save|pay off|budget|retire|invest|pick|choose|get|lower|improve|build)|ways to (?:save|pay|cut|build|boost)|tips (?:for|to)|what you need to know about your|can you afford|how much (?:you|i) (?:need|should)|your (?:401\(?k\)?|ira|credit score|mortgage|retirement|paycheck|taxes|savings|budget)|side hustle|save money|frugal|coupon|best (?:credit cards?|savings accounts?|cd rates|mortgage lenders|personal loans?|insurance) for)\b/i;

// Paid-wire boilerplate: class-action solicitations and vendor announcements
// syndicate into markets feeds in volume and read as news.
const PRESS_RELEASE_RE =
  /(class action|shareholders? (?:who|with) losses|encourages? .{0,40}investors|law firm|deadline reminder|investigation (?:on behalf|into) |reminds? investors|webinar|sponsored)/i;

// First-person advice columns ("My husband got a $42,000 bonus...").
const FIRST_PERSON_LEAD_RE = /^(my|our|i'm|i am|i've|i have|i need|i want|can i|should i|do i|we|can we|should we)\b/i;

// Ticker bait: stock-picking listicles and price-target churn. Shared with the
// scout, which uses the same test to score a candidate publisher.
export const TICKER_BAIT_RE =
  /\((?:NYSE|NASDAQ|NASDAQGS|OTC|TSX)?:?\s?[A-Z]{1,5}\)|should you buy|stocks? to (?:buy|watch|sell)|\b\d+ (?:stocks|ways|things|reasons)\b|here's why|price target|is it time to|top picks?/i;

// Headlines in another script. The page is in English and the classifier is
// told to drop foreign-language stories, but Business Today's feed mixes in
// Hindi (on 30 September 2026, 2 of 79 of its stories) and each one cost a
// model call to throw away. More than a third of the letters in a non-Latin
// script means the headline is not English.
function mostlyNonLatin(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 4) return false;
  const nonLatin = letters.filter((ch) => !/\p{Script=Latin}/u.test(ch)).length;
  return nonLatin / letters.length > 0.34;
}

export type FilterVerdict = { keep: true } | { keep: false; reason: string };

export function filterItem(item: RawItem, now: Date = new Date(), maxAgeHours = MAX_AGE_HOURS): FilterVerdict {
  const domain = (item.publisherDomain ?? "").replace(/^www\./, "");
  if (domain && (BLOCKED_DOMAINS.has(domain) || [...BLOCKED_DOMAINS].some((d) => domain.endsWith("." + d)))) {
    return { keep: false, reason: "blocked_publisher" };
  }
  if (!item.publishedAt) return { keep: false, reason: "no_date" };
  const ageHours = (now.getTime() - item.publishedAt.getTime()) / 3_600_000;
  if (ageHours > maxAgeHours) return { keep: false, reason: "too_old" };
  // A little slack for publishers whose clocks run ahead; a day ahead is a bad date.
  if (ageHours < -2) return { keep: false, reason: "future_date" };

  if (mostlyNonLatin(item.title)) return { keep: false, reason: "not_english" };

  const title = item.title.replace(/[’‘]/g, "'");
  if (CONSUMER_TOPIC_RE.test(title)) return { keep: false, reason: "consumer" };
  if (PRESS_RELEASE_RE.test(title)) return { keep: false, reason: "press_release" };
  if (TICKER_BAIT_RE.test(title)) return { keep: false, reason: "ticker_bait" };
  const tail = (title.lastIndexOf(":") >= 0 ? title.slice(title.lastIndexOf(":") + 1) : title).trim();
  if (FIRST_PERSON_LEAD_RE.test(tail)) return { keep: false, reason: "first_person" };

  // The project rule: hateful language and profanity never reach a student,
  // including in a publisher's own headline, summary or name.
  if (findBlockedLanguage(item.title) || findBlockedLanguage(item.description) || findBlockedLanguage(item.publisher)) {
    return { keep: false, reason: "blocked_language" };
  }
  return { keep: true };
}

// Tracking parameters differ between two links to the same article, so they
// are removed before hashing - otherwise every re-share is a "new" story.
const TRACKING_PARAM_RE = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|cmpid$|ocid$|mod$|taid$|smid$|ref$|src$|rss$|feed$)/i;

export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM_RE.test(key)) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.replace(/^(www|amp)\./, "");
    u.pathname = u.pathname.replace(/\/amp\/?$/, "/").replace(/\/+$/, "") || "/";
    return u.toString();
  } catch {
    return url.trim();
  }
}

export function urlHash(url: string): string {
  return createHash("sha256").update(canonicalUrl(url)).digest("hex");
}

/**
 * The headline reduced to what survives syndication: lower case, no
 * punctuation, no trailing " - Publisher" or " | Publisher". Yahoo carrying a
 * Reuters story, or Google returning the same WSJ piece for two sector
 * searches, lands on the same key.
 */
export function titleKey(title: string): string {
  return title
    .replace(/\s+[-|–—]\s+[^-|–—]{2,40}$/, "")
    .toLowerCase()
    .replace(/[’‘']/g, "")
    .replace(/[^a-z0-9$%]+/g, " ")
    .trim();
}

export function trimDescription(description: string | null, title: string): string | null {
  if (!description) return null;
  // Many feeds repeat the headline as the summary, which tells the model nothing.
  if (titleKey(description) === titleKey(title)) return null;
  if (description.length <= DESCRIPTION_LIMIT) return description;
  const cut = description.slice(0, DESCRIPTION_LIMIT);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), DESCRIPTION_LIMIT - 40)) + "…";
}
