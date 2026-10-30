/**
 * Everything about the contact search that depends on how Crustdata behaves -
 * and that we have NOT confirmed with them - in one place.
 *
 * Each capability below is our current working assumption, marked with how we
 * know it. When Crustdata answers the questions in OPEN_PROVIDER_QUESTIONS,
 * change the value here and the pool (lib/contact-pool) and the request
 * builder follow; nothing else should need to guess.
 */

import type { ContactSearchQuery } from "@/lib/contact-sourcing-agent";
import type { Tier } from "@/lib/contact-tiers";
import type { AffinitySignal, SignalCategory } from "@/lib/contact-pool";

export type ProviderCapabilities = {
  /**
   * The free-text parameter narrows the result set (observed: an Evercore run
   * returned five people without it and none with it). Unknown: whether it is
   * AND, OR or semantic. Because it narrows, free text is never added to the
   * baseline ladder - only to separate affinity searches.
   */
  freeTextNarrows: boolean;
  /**
   * How the spellings of one signal are sent.
   *  - "primary-only": the first spelling alone ("Trojan Investing Society").
   *    Assumes nothing about how several words combine.
   *  - "single-query": every spelling in one string ("Trojan Investing Society
   *    TIS"). Only safe if the free text is OR or semantic - if it is AND, a
   *    profile would need both spellings and the search could return nobody.
   * Until Crustdata says how the free text combines words, primary-only.
   */
  aliasStrategy: "primary-only" | "single-query";
  /**
   * Whether a search's result order means relevance. Unknown - so the pool
   * never treats position as a signal; it only breaks ties deterministically.
   */
  resultsRelevanceRanked: boolean;
  /**
   * Signal categories assumed to be findable by the free-text search. Which
   * profile fields hybrid mode reads is unconfirmed (OPEN_PROVIDER_QUESTIONS),
   * so this is an allow-list to narrow once they answer - a category off it is
   * never spent on.
   */
  searchableCategories: readonly SignalCategory[];
  /**
   * Can past employers be filtered on? Unknown - so no prior-employer search.
   * Setting this true is not enough on its own: affinityQuery would still send
   * the employer as free text. A real past-employer filter has to be added to
   * the request builder first.
   */
  supportsPastEmployerFilter: boolean;
  /** Can free text boost ranking without filtering? Unknown - assumed no. */
  supportsRankingBoost: boolean;
  /** Does a result say which field matched? Unknown - assumed no. */
  returnsMatchHighlights: boolean;
  /**
   * Which comparable fields come back on a profile. Today's parser
   * (crustdata-client fromCrustdataProfile) maps clubs, interests and hometown
   * to null - unknown, not "none".
   */
  returnsClubs: boolean;
  returnsInterests: boolean;
  returnsHometown: boolean;
};

export const CRUSTDATA_CAPABILITIES: ProviderCapabilities = {
  freeTextNarrows: true, // observed
  aliasStrategy: "primary-only", // pending the AND/OR answer
  resultsRelevanceRanked: false, // unconfirmed
  searchableCategories: ["club", "hometown", "interest", "coverage"], // assumed; prior employer is a separate flag
  supportsPastEmployerFilter: false, // unconfirmed
  supportsRankingBoost: false, // unconfirmed
  returnsMatchHighlights: false, // unconfirmed
  returnsClubs: false, // parser returns null
  returnsInterests: false, // parser returns null
  returnsHometown: false, // parser returns null
};

/**
 * The rollout guard for private affinity searches.
 *
 * Affinity searches send a student's clubs, interests, coverage and hometown
 * to Crustdata. They stay OFF unless CONTACT_AFFINITY_SEARCH=on, and must not
 * be switched on in production until (1) the published privacy policy and
 * POLICY_VERSION describe this transmission and (2) Crustdata's role as a
 * service provider for these query terms is confirmed (DPA review). With it
 * off, contact generation runs the baseline ladder alone and no free text is
 * sent anywhere.
 */
export function affinitySearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTACT_AFFINITY_SEARCH?.trim().toLowerCase() === "on";
}

/**
 * The rung an affinity search uses: the student's school and the seat stay,
 * city and graduation year are dropped, and the free text is the one thing
 * narrowing it. Keeping the school keeps affinity candidates inside the
 * school-first rule; the pool validates them against it as well.
 */
export const AFFINITY_TIER: Tier = {
  label: "affinity",
  drop: ["city", "gradYear"],
  keywords: true,
};

/**
 * The query for one affinity search: the plan, with this signal as the free
 * text - one spelling or all of them, per `aliasStrategy`. Each signal is its
 * own search, so one overly narrow term can empty only its own results.
 */
export function affinityQuery(
  base: ContactSearchQuery,
  signal: AffinitySignal,
  limit: number,
  capabilities: ProviderCapabilities = CRUSTDATA_CAPABILITIES,
): ContactSearchQuery {
  const terms = capabilities.aliasStrategy === "single-query" ? [...signal.terms] : signal.terms.slice(0, 1);
  return { ...base, keywords: terms, limit };
}

/**
 * For Crustdata. Not sent anywhere from code - kept here so the questions and
 * the assumptions above stay next to each other.
 */
export const OPEN_PROVIDER_QUESTIONS = [
  "Hybrid mode (`search: { query, mode: \"hybrid\" }`): is the query AND, OR, or semantic relevance? Does a multi-word query need every word?",
  "Which profile fields does hybrid mode search: headline, summary, current/past titles, education, activities, skills?",
  "Is there a way to boost ranking by free text WITHOUT filtering results out?",
  "Can a response say which field (or which term) matched - highlights or field provenance?",
  "Can person/search or person/enrich return activities/organizations, interests, summary/about, or hometown/location history?",
  "Can we filter on PAST employers (e.g. experience.employment_details.past.company_id or name)?",
  "Is a larger search (e.g. 20 results) followed by enriching only the chosen five cost-effective - what does a search result cost versus an enrichment?",
] as const;
