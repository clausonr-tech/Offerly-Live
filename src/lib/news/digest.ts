import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { firms, newsClusters, newsDigests, newsItemFirms, newsItems, userTopFirms, users } from "@/db/schema";
import { LOCKED_PENALTY, LOCKED_PER_ROW, canRead, capLocked, paidPublisherOf } from "./access";
import { hiddenLinks } from "./takedown";
import { cardExtras, readableCopies } from "./card-extras";
import { readTab } from "./read";
import type { StorySummary } from "./summary";
import { SECTOR_LABELS, SPECIALTIES_BY_SECTOR, isSector, type Sector } from "./types";
import { currentSpecialties } from "../question-bank/specialties";

type Db = Awaited<ReturnType<typeof getDb>>;

// The student's daily digest: what opens first on /news.
//
// It is assembled by code from stories the pipeline has already labelled and
// ranked - no model writes anything per student - so it costs nothing per
// student and carries exactly the quality checks every tab does.
//
// Two sources of relevance, in this order:
//   1. Their top firms. Any event that involves one of the firms on their
//      list (Evercore's latest deal, a leadership change at Blackstone).
//   2. Their industries, in the order they picked them. Within each, stories
//      tagged with a specialty they chose ("Healthcare Coverage") come first,
//      then the industry's most important stories fill in - so a slow day in
//      healthcare banking still shows the day's biggest banking news.
// An event appears once, in the first section that claims it.
//
// "Daily" means a morning edition: built the first time the student opens News
// after 5am in their time zone, stored, and shown unchanged until the next
// morning. Breaking stories still reach the sector tabs.

export type DigestStory = {
  /** The lead story's id, for the Report link. Missing from editions stored before 30 September 2026. */
  id?: string;
  /** The event's id, so a stored edition's photos can be refreshed when it is read. */
  clusterId?: string;
  /** For the tile a card shows when there is no photo. */
  sector?: string | null;
  firmName?: string | null;
  firmDomain?: string | null;
  /** Refreshed with the photo every time the edition is read, so a summary written after the morning still shows. */
  summary?: StorySummary | null;
  title: string;
  link: string;
  source: string;
  sourceDomain: string | null;
  publishedAt: string | null;
  imageUrl: string | null;
  outlets: number;
  paywall: boolean;
  unconfirmed: boolean;
  opinion: boolean;
  /** Why it is in this student's digest: a firm name or a specialty. */
  because: string | null;
  /** Paid, and not one of the student's subscriptions. Missing from editions stored before 30 September 2026. */
  locked?: boolean;
};

export type DigestSection = {
  kind: "firms" | "sector" | "top";
  title: string;
  sector: Sector | null;
  stories: DigestStory[];
};

export type Digest = {
  edition: string;
  builtAt: string;
  sectors: Sector[];
  specialties: string[];
  firmCount: number;
  /** The day's main story, for the banner. Missing from editions stored before 30 September 2026. */
  main?: DigestStory | null;
  sections: DigestSection[];
};

/** One ranked event, as the digest sees it. */
export type DigestCandidate = {
  clusterId: string;
  story: Omit<DigestStory, "because">;
  sectors: string[];
  specialties: string[];
  scores: Record<string, number>;
  firmIds: string[];
  firstSeenAt: Date;
  /** Only a paid source the student lacks has reported it. */
  locked?: boolean;
};

// Four stories a section: one row of cards, the owner's call on 30 September 2026.
const FIRM_STORIES = 4;
const PER_SECTOR = 4;
const TOP_STORIES = 4;
const MAIN_STORY_HOURS = 24;
// Firm news older than this is not news to the student any more.
const FIRM_WINDOW_HOURS = 7 * 24;
const SECTOR_WINDOW_HOURS = 72;
// The edition turns over at 5am local, so a student opening News at 1am still
// sees last night's edition rather than an empty morning one.
const EDITION_ROLLOVER_HOURS = 5;

const score = (c: DigestCandidate, key: string) => c.scores[key] ?? 0;
const bestScore = (c: DigestCandidate) => Math.max(0, ...Object.entries(c.scores).filter(([k]) => k !== "unconfirmed").map(([, v]) => v));

/** The student's local date for their current edition, YYYY-MM-DD. */
export function editionDate(now: Date, timeZone: string | null): string {
  const shifted = new Date(now.getTime() - EDITION_ROLLOVER_HOURS * 3_600_000);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? "America/New_York" }).format(shifted);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(shifted);
  }
}

/**
 * Which sections a student gets, from candidates already ranked by the
 * pipeline. Pure, so the rules can be tested without a database.
 */
export function assembleDigest(input: {
  candidates: DigestCandidate[];
  sectors: Sector[];
  specialties: string[];
  topFirms: { id: string; name: string }[];
  now: Date;
  /** Events already shown elsewhere on the page (the main story). */
  exclude?: string[];
}): DigestSection[] {
  const { candidates, now } = input;
  const used = new Set<string>(input.exclude ?? []);
  const sections: DigestSection[] = [];
  const age = (c: DigestCandidate) => (now.getTime() - c.firstSeenAt.getTime()) / 3_600_000;

  // 1. Their firms. Ranked by the event's importance, and labelled with the
  //    firm that put it here - the highest one on their list, if several do.
  const firmRank = new Map(input.topFirms.map((f, i) => [f.id, i]));
  const firmName = new Map(input.topFirms.map((f) => [f.id, f.name]));
  const isLocked = (c: DigestCandidate) => Boolean(c.locked);
  const firmStories = capLocked(
    candidates
      .filter((c) => !used.has(c.clusterId) && age(c) <= FIRM_WINDOW_HOURS && c.firmIds.some((id) => firmRank.has(id)) && bestScore(c) > 0)
      .sort((a, b) => bestScore(b) - bestScore(a)),
    isLocked,
    LOCKED_PER_ROW,
  )
    .slice(0, FIRM_STORIES)
    .map((c) => {
      used.add(c.clusterId);
      const firm = [...c.firmIds].filter((id) => firmRank.has(id)).sort((x, y) => firmRank.get(x)! - firmRank.get(y)!)[0];
      return { ...c.story, because: firmName.get(firm) ?? null };
    });
  if (firmStories.length) sections.push({ kind: "firms", title: "Your firms", sector: null, stories: firmStories });

  // 2. Their industries, in the order they picked them.
  const chosen = new Set(input.specialties);
  for (const sector of input.sectors) {
    const theirs = SPECIALTIES_BY_SECTOR[sector].filter((s) => chosen.has(s));
    const pool = candidates.filter((c) => !used.has(c.clusterId) && score(c, sector) > 0 && age(c) <= SECTOR_WINDOW_HOURS);
    const matched = pool
      .filter((c) => c.specialties.some((s) => theirs.includes(s)))
      .sort((a, b) => score(b, sector) - score(a, sector));
    const rest = pool.filter((c) => !matched.includes(c)).sort((a, b) => score(b, sector) - score(a, sector));
    const picks = capLocked([...matched, ...rest], isLocked, LOCKED_PER_ROW).slice(0, PER_SECTOR);
    if (picks.length === 0) continue;
    sections.push({
      kind: "sector",
      title: SECTOR_LABELS[sector],
      sector,
      stories: picks.map((c) => {
        used.add(c.clusterId);
        return { ...c.story, because: c.specialties.find((s) => theirs.includes(s)) ?? null };
      }),
    });
  }

  // 3. Nothing to go on - no interests, no firm news: the day's top stories,
  //    so the page is never empty for a student who skipped onboarding.
  if (sections.length === 0) {
    const top = capLocked(
      candidates
        .filter((c) => !used.has(c.clusterId) && score(c, "main") > 0 && age(c) <= SECTOR_WINDOW_HOURS)
        .sort((a, b) => score(b, "main") - score(a, "main")),
      isLocked,
      LOCKED_PER_ROW,
    )
      .slice(0, TOP_STORIES)
      .map((c) => ({ ...c.story, because: null }));
    if (top.length) sections.push({ kind: "top", title: "Today's top stories", sector: null, stories: top });
  }
  return sections;
}

/**
 * The day's main story: the highest-ranked event on Top stories from the last
 * day, or the last three days when the last day has none - one the student
 * can open, unless every candidate is locked.
 */
export function pickMainStory(candidates: DigestCandidate[], now: Date): DigestCandidate | null {
  const age = (c: DigestCandidate) => (now.getTime() - c.firstSeenAt.getTime()) / 3_600_000;
  for (const readableOnly of [true, false]) {
    for (const hours of [MAIN_STORY_HOURS, SECTOR_WINDOW_HOURS]) {
      const best = candidates
        .filter((c) => (!readableOnly || !c.locked) && score(c, "main") > 0 && age(c) <= hours)
        .sort((a, b) => score(b, "main") - score(a, "main"))[0];
      if (best) return best;
    }
  }
  return null;
}

/**
 * The candidates as this student sees them: a story from a paid source they
 * lack becomes a readable outlet's copy of the same event when one exists,
 * and otherwise is marked locked and scored down (access.ts).
 */
async function applyAccess(db: Db, candidates: DigestCandidate[], access: readonly string[]): Promise<DigestCandidate[]> {
  const unreadable = candidates.filter((c) => !canRead(c.story.sourceDomain, access));
  if (unreadable.length === 0) return candidates;
  const copies = await readableCopies(db, unreadable.map((c) => c.clusterId), access);
  return candidates.map((c) => {
    if (canRead(c.story.sourceDomain, access)) return { ...c, story: { ...c.story, locked: false } };
    const copy = copies.get(c.clusterId);
    if (copy) {
      return {
        ...c,
        story: { ...c.story, id: copy.itemId, title: copy.title, link: copy.link, source: copy.source, sourceDomain: copy.sourceDomain, publishedAt: copy.publishedAt.toISOString(), paywall: paywalled(copy.sourceDomain), locked: false },
      };
    }
    const scores = Object.fromEntries(Object.entries(c.scores).map(([k, v]) => [k, k === "unconfirmed" ? v : v * LOCKED_PENALTY]));
    return { ...c, scores, locked: true, story: { ...c.story, locked: true } };
  });
}

/** Photos, firms and sectors for a digest's cards, read fresh - the photo step keeps finding photos after the edition is stored. */
async function withCardExtras(db: Db, digest: Digest): Promise<Digest> {
  const all = [digest.main, ...digest.sections.flatMap((s) => s.stories)].filter((s): s is DigestStory => Boolean(s));
  if (all.length === 0) return digest;
  // Editions stored before 30 September 2026 carry no event id; find it by link.
  const missing = all.filter((s) => !s.clusterId).map((s) => s.link);
  const byLink = new Map<string, { clusterId: string; sector: string | null }>();
  if (missing.length) {
    const rows = await db
      .select({ url: newsItems.url, clusterId: newsItems.clusterId, sector: newsClusters.primarySector })
      .from(newsItems)
      .leftJoin(newsClusters, eq(newsClusters.id, newsItems.clusterId))
      .where(inArray(newsItems.url, missing));
    for (const r of rows) if (r.clusterId) byLink.set(r.url, { clusterId: r.clusterId, sector: r.sector });
  }
  const clusterOf = (s: DigestStory) => s.clusterId ?? byLink.get(s.link)?.clusterId;
  const ids = [...new Set(all.map(clusterOf).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) {
    const noPhoto = (s: DigestStory): DigestStory => ({ ...s, imageUrl: null });
    return { ...digest, main: digest.main ? noPhoto(digest.main) : digest.main, sections: digest.sections.map((sec) => ({ ...sec, stories: sec.stories.map(noPhoto) })) };
  }
  const extras = await cardExtras(db, ids.map((id) => ({ id, leadItemId: all.find((s) => clusterOf(s) === id)?.id })));
  const patch = (s: DigestStory): DigestStory => {
    const id = clusterOf(s);
    const e = id ? extras.get(id) : undefined;
    // The photo is always the checked one through the image route; a stored
    // edition's own imageUrl (the publisher's, from before) is never shown.
    if (!e) return { ...s, imageUrl: null, summary: null };
    // In "Your firms" the card is labelled with the student's firm; its tile shows that firm.
    const firm = e.firms.find((f) => f.name === s.because) ?? e.firms[0];
    return { ...s, imageUrl: e.imageUrl, summary: e.summary, firmName: firm?.name ?? null, firmDomain: firm?.domain ?? null, sector: s.sector ?? byLink.get(s.link)?.sector ?? null };
  };
  return {
    ...digest,
    main: digest.main ? patch(digest.main) : digest.main,
    sections: digest.sections.map((sec) => ({ ...sec, stories: sec.stories.map(patch) })),
  };
}

function paywalled(domain: string | null): boolean {
  return paidPublisherOf(domain) !== null;
}

async function loadCandidates(db: Db, now: Date): Promise<DigestCandidate[]> {
  const since = new Date(now.getTime() - FIRM_WINDOW_HOURS * 3_600_000);
  const rows = await db
    .select({
      clusterId: newsClusters.id,
      sectors: newsClusters.sectors,
      specialties: newsClusters.specialties,
      scores: newsClusters.scores,
      storyType: newsClusters.storyType,
      outlets: newsClusters.publisherCount,
      firstSeenAt: newsClusters.firstSeenAt,
      itemId: newsItems.id,
      title: newsItems.title,
      link: newsItems.url,
      source: newsItems.publisher,
      sourceDomain: newsItems.publisherDomain,
      publishedAt: newsItems.publishedAt,
      imageUrl: newsItems.imageUrl,
    })
    .from(newsClusters)
    .innerJoin(newsItems, eq(newsItems.id, newsClusters.leadItemId))
    .where(and(gte(newsClusters.firstSeenAt, since), isNull(newsItems.hiddenAt)));
  if (rows.length === 0) return [];

  // Firms linked to ANY report of an event, not just the lead story - the
  // Reuters copy may name Evercore as adviser where the lead does not.
  const links = await db
    .select({ clusterId: newsItems.clusterId, firmId: newsItemFirms.firmId })
    .from(newsItemFirms)
    .innerJoin(newsItems, eq(newsItems.id, newsItemFirms.itemId))
    .where(inArray(newsItems.clusterId, rows.map((r) => r.clusterId)));
  const firmsByCluster = new Map<string, Set<string>>();
  for (const l of links) {
    if (!l.clusterId) continue;
    firmsByCluster.set(l.clusterId, (firmsByCluster.get(l.clusterId) ?? new Set()).add(l.firmId));
  }

  return rows.map((r) => {
    const scores = (r.scores as Record<string, number>) ?? {};
    return {
      clusterId: r.clusterId,
      sectors: r.sectors,
      // Stories tagged before a specialty was folded into another read as the new one.
      specialties: currentSpecialties(r.specialties),
      scores,
      firmIds: [...(firmsByCluster.get(r.clusterId) ?? [])],
      firstSeenAt: r.firstSeenAt,
      story: {
        id: r.itemId,
        clusterId: r.clusterId,
        sector: r.sectors[0] ?? null,
        title: r.title,
        link: r.link,
        source: r.source,
        sourceDomain: r.sourceDomain,
        publishedAt: r.publishedAt.toISOString(),
        imageUrl: null, // set from the checked photo by withCardExtras
        outlets: r.outlets,
        paywall: paywalled(r.sourceDomain),
        unconfirmed: Boolean(scores.unconfirmed),
        opinion: r.storyType === "commentary",
      },
    };
  });
}

export async function buildDigest(db: Db, userId: string, now: Date = new Date()): Promise<Digest> {
  const [user] = await db
    .select({ preferredCategories: users.preferredCategories, nicheInterests: users.nicheInterests, timeZone: users.timeZone, newsAccess: users.newsAccess })
    .from(users)
    .where(eq(users.id, userId));
  const sectors = (user?.preferredCategories ?? []).filter(isSector);
  const specialties = currentSpecialties(user?.nicheInterests);
  const topFirms = await db
    .select({ id: firms.id, name: firms.name })
    .from(userTopFirms)
    .innerJoin(firms, eq(firms.id, userTopFirms.firmId))
    .where(eq(userTopFirms.userId, userId))
    .orderBy(sql`${userTopFirms.matchScore} desc nulls last`, asc(userTopFirms.createdAt));

  // A student who has not said which paid sources they have is treated as having none.
  const candidates = await applyAccess(db, await loadCandidates(db, now), user?.newsAccess ?? []);
  const main = pickMainStory(candidates, now);
  const sections = assembleDigest({ candidates, sectors, specialties, topFirms, now, exclude: main ? [main.clusterId] : [] });
  return withCardExtras(db, {
    edition: editionDate(now, user?.timeZone ?? null),
    builtAt: now.toISOString(),
    sectors,
    specialties,
    firmCount: topFirms.length,
    main: main ? { ...main.story, because: null } : null,
    sections,
  });
}

/** Whether a stored edition was built for the industries and specialties the student has now. */
export function sameInterests(digest: Pick<Digest, "sectors" | "specialties">, current: { sectors: string[]; specialties: string[] }): boolean {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  // Order matters for sectors: the digest lists industries in the order picked.
  return same(digest.sectors ?? [], current.sectors) && same([...(digest.specialties ?? [])].sort(), [...current.specialties].sort());
}

/**
 * Today's edition for this student: the stored one if it exists, otherwise
 * built now and stored. An edition with no stories at all is not stored, so a
 * student who opens News before the pipeline has run gets a real one later.
 */
export async function getDigest(db: Db, userId: string, now: Date = new Date()): Promise<Digest> {
  const [user] = await db
    .select({ timeZone: users.timeZone, preferredCategories: users.preferredCategories, nicheInterests: users.nicheInterests })
    .from(users)
    .where(eq(users.id, userId));
  const edition = editionDate(now, user?.timeZone ?? null);
  const [stored] = await db
    .select({ payload: newsDigests.payload })
    .from(newsDigests)
    .where(and(eq(newsDigests.userId, userId), eq(newsDigests.editionDate, edition)))
    .orderBy(desc(newsDigests.createdAt))
    .limit(1);
  // The digest shows the industries the student picked and nothing else. An
  // edition stored before they changed their picks is rebuilt, not shown.
  const current = { sectors: (user?.preferredCategories ?? []).filter(isSector), specialties: currentSpecialties(user?.nicheInterests) };
  if (stored && !sameInterests(stored.payload as Digest, current)) {
    const rebuilt = await buildDigest(db, userId, now);
    await db
      .insert(newsDigests)
      .values({ userId, editionDate: edition, payload: rebuilt })
      .onConflictDoUpdate({ target: [newsDigests.userId, newsDigests.editionDate], set: { payload: rebuilt, createdAt: new Date() } });
    return rebuilt;
  }
  if (stored) {
    // The edition is kept all day, so a story taken down since this morning is
    // removed from it here rather than waiting for tomorrow's.
    let digest = stored.payload as Digest;
    // An edition stored before the banner existed gets today's top story now.
    if (digest.main === undefined) {
      const [top] = await readTab(db, null, 1, now);
      digest = { ...digest, main: top ? { ...top, because: null } : null };
    }
    const links = [digest.main?.link, ...digest.sections.flatMap((s) => s.stories.map((story) => story.link))].filter((l): l is string => Boolean(l));
    const hidden = await hiddenLinks(db, links);
    digest = {
      ...digest,
      main: digest.main && hidden.has(digest.main.link) ? null : digest.main,
      // Editions stored before 30 September 2026 held up to twelve a section.
      sections: digest.sections.map((s) => ({ ...s, stories: s.stories.filter((story) => !hidden.has(story.link)).slice(0, FIRM_STORIES) })),
    };
    return withCardExtras(db, digest);
  }

  const digest = await buildDigest(db, userId, now);
  if (digest.sections.some((s) => s.stories.length > 0)) {
    await db.insert(newsDigests).values({ userId, editionDate: edition, payload: digest }).onConflictDoNothing();
  }
  return digest;
}
