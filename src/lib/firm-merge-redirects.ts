import "server-only";
import firmMerges from "./firm-merges.json";

// Kept apart from ./firm-content so a request that only needs to redirect an
// absorbed firm's old link (the firm detail page) reads this ~30KB file rather
// than building the whole ~22.5k-firm catalog.

/** Absorbed slug -> the brand it now lives under, for redirecting old links. */
export const FIRM_MERGE_REDIRECTS: ReadonlyMap<string, string> = new Map(
  (firmMerges as { canonicalSlug: string; absorbs: string[] }[]).flatMap((m) =>
    m.absorbs.map((s) => [s, m.canonicalSlug] as const),
  ),
);
