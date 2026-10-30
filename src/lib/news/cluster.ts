// Stage 3: stories about the same event, grouped. Code only - no embeddings
// and no model.
//
// The classifier has already pulled out what identifies an event: the firms
// involved, the kind of story and the amount. Those are sharper than headline
// similarity, which tends to merge "KKR raises a fund" with "KKR buys X" - two
// stories that share a firm and most of their words and nothing else.
//
// Two stories join when, within 48 hours of each other:
//   - they share a firm (or a named entity), AND either they are the same kind
//     of story with amounts within 10%, or their headlines share at least 35%
//     of their words; or
//   - their headlines are near-identical (60% of words) whatever the entities.

export type ClusterInput = {
  id: string;
  publishedAt: Date;
  title: string;
  storyType: string | null;
  amountUsd: number | null;
  /** Linked firm ids plus normalised entity names - anything that names who the story is about. */
  actors: string[];
  publisher: string;
  alsoPublishedBy: string[];
};

const STOPWORDS = new Set(
  "a an and as at be by for from has have in into is it its of on or over says said the to up with after amid new its will than that this report reports sources".split(" "),
);

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[’']/g, "")
      .split(/[^a-z0-9$]+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

const WINDOW_MS = 48 * 3_600_000;
const DEAL_TYPES = new Set(["ma", "ecm_ipo", "fund_raise", "startup_round", "debt_financing"]);

function sameEvent(a: ClusterInput, b: ClusterInput, ta = titleTokens(a.title), tb = titleTokens(b.title)): boolean {
  if (Math.abs(a.publishedAt.getTime() - b.publishedAt.getTime()) > WINDOW_MS) return false;
  const similarity = jaccard(ta, tb);
  if (similarity >= 0.6) return true;
  if (!a.actors.some((x) => b.actors.includes(x))) return false;
  const amountsAgree =
    a.amountUsd !== null && b.amountUsd !== null && Math.abs(a.amountUsd - b.amountUsd) <= 0.1 * Math.max(a.amountUsd, b.amountUsd);
  // The same firm doing the same kind of deal within a day, where one report
  // gives no amount: one deal described two ways ("AMD's $8 billion deal" and
  // "AMD makes a big bet with World Labs acquisition"). A firm announcing two
  // acquisitions in one day is rare enough to accept the merge.
  const sameDealNoAmount =
    a.storyType !== null &&
    a.storyType === b.storyType &&
    DEAL_TYPES.has(a.storyType) &&
    (a.amountUsd === null || b.amountUsd === null) &&
    Math.abs(a.publishedAt.getTime() - b.publishedAt.getTime()) <= 24 * 3_600_000;
  return (a.storyType !== null && a.storyType === b.storyType && amountsAgree) || sameDealNoAmount || similarity >= 0.35;
}

/**
 * Groups stories into events. Each group's id is its earliest story's id, so a
 * cluster keeps the same id from run to run as later coverage joins it - which
 * is what lets the sector desk's picks keep pointing at the right event.
 */
export function clusterStories(items: ClusterInput[]): Map<string, ClusterInput[]> {
  const sorted = [...items].sort((x, y) => x.publishedAt.getTime() - y.publishedAt.getTime() || x.id.localeCompare(y.id));
  const parent = new Map(sorted.map((i) => [i.id, i.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const tokens = new Map(sorted.map((i) => [i.id, titleTokens(i.title)]));

  // Pairs only need checking inside the 48-hour window, and the list is sorted
  // by time, so each story is compared with the ones just after it.
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].publishedAt.getTime() - sorted[i].publishedAt.getTime() > WINDOW_MS) break;
      if (sameEvent(sorted[i], sorted[j], tokens.get(sorted[i].id), tokens.get(sorted[j].id))) {
        const a = find(sorted[i].id);
        const b = find(sorted[j].id);
        if (a !== b) {
          // The earlier story's root wins, so the id stays the event's first report.
          const earlier = sorted.findIndex((s) => s.id === a) < sorted.findIndex((s) => s.id === b) ? a : b;
          parent.set(a === earlier ? b : a, earlier);
        }
      }
    }
  }

  const groups = new Map<string, ClusterInput[]>();
  for (const item of sorted) {
    const root = find(item.id);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  }
  return groups;
}

/** Distinct outlets reporting an event, syndicated copies included. */
export function publisherCount(members: ClusterInput[]): number {
  const names = new Set<string>();
  for (const m of members) {
    names.add(m.publisher.toLowerCase());
    for (const p of m.alsoPublishedBy) names.add(p.toLowerCase());
  }
  return names.size;
}
