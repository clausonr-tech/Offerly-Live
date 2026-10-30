import { CATEGORY_LABELS, type FirmProgramCategory } from "../firm-metadata";
import { QUIZ_SPECIALTIES } from "../question-bank/specialties";

// The vocabulary the news tables store as plain text (see the news section of
// src/db/schema.ts for why they are not Postgres enums). Everything that
// writes one of these columns validates against the lists here first.

export type Sector = FirmProgramCategory;
export const SECTORS = Object.keys(CATEGORY_LABELS) as Sector[];
export const SECTOR_LABELS: Record<Sector, string> = CATEGORY_LABELS;

/**
 * The specialties inside each sector - the same list onboarding offers ("Which
 * product or coverage group are you targeting?"), the profile's Interests page
 * edits and Interview Prep uses. Stories are tagged from this list so a
 * student's "Healthcare Coverage" matches a story's "Healthcare Coverage"
 * exactly, with nothing to translate.
 */
export const SPECIALTIES_BY_SECTOR = QUIZ_SPECIALTIES as Record<Sector, readonly string[]>;
export const ALL_SPECIALTIES: string[] = [...new Set(Object.values(SPECIALTIES_BY_SECTOR).flat())];

export function isSector(value: unknown): value is Sector {
  return typeof value === "string" && (SECTORS as string[]).includes(value);
}

/**
 * primary: a filing or a regulator's own release. major: a national newsroom
 * trusted on any finance topic. trade: a specialist trusted only for its own
 * sectors. blocked: never ingested, kept so the scout does not re-propose it.
 */
type SourceTier = "primary" | "major" | "trade" | "blocked";
export type SourceKind = "rss" | "google_site" | "edgar" | "regulator";
export type ItemOrigin = "rss" | "google" | "edgar" | "regulator";

export const STORY_TYPES = [
  "ma",
  "ecm_ipo",
  "debt_financing",
  "fund_raise",
  "startup_round",
  "earnings",
  "people_move",
  "regulation",
  "enforcement",
  "markets_macro",
  "strategy",
  "distress",
  "activism",
  "industry_trend",
  "commentary",
  "other",
] as const;
export type StoryType = (typeof STORY_TYPES)[number];

export const ABSTAIN_REASONS = ["not_finance", "consumer", "promo", "opinion", "speculative", "insufficient_info"] as const;

export const ENTITY_ROLES = [
  "acquirer",
  "target",
  "advisor",
  "investor",
  "issuer",
  "lender",
  "regulator",
  "subject",
] as const;
type EntityRole = (typeof ENTITY_ROLES)[number];

export const REGIONS = ["us", "uk", "europe", "asia", "other", "global"] as const;
export type Region = (typeof REGIONS)[number];

export type Entity = { name: string; role: EntityRole };

/** A registry entry as written in sources.ts, before it is synced to news_sources. */
export type SourceSeed = {
  id: string;
  name: string;
  domain: string;
  tier: SourceTier;
  sectors: Sector[];
  kind: SourceKind;
  url: string;
  region?: Region;
  paywall?: boolean;
  /**
   * A person reviewed this source's photos and found only real editorial
   * photography, so its photos skip the vision check. Every other source's
   * photos are shown only once the vision check has passed them (photos.ts).
   */
  photos?: boolean;
  notes?: string;
};

/** One parsed feed entry, before filtering. */
export type RawItem = {
  title: string;
  url: string;
  description: string | null;
  publisher: string;
  publisherDomain: string | null;
  imageUrl: string | null;
  publishedAt: Date | null;
};
