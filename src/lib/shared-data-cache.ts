import "server-only";
import { unstable_cache } from "next/cache";

/**
 * Cross-request cache policy for data that is identical for every student.
 *
 * The cache itself is Next/Vercel's Data Cache. Supabase remains the source of
 * truth; putting the cache in front of it is what removes repeated network
 * round trips to Supabase. Never use these tags for sessions, messages,
 * applications, recordings, consent, scores, or any other per-user data.
 */
export const SHARED_CACHE_SECONDS = {
  /** Frequently changing published content, such as jobs and news. */
  liveCatalog: 60,
  /** Curated reference data, such as firms and interview questions. */
  reference: 300,
} as const;

export const SHARED_CACHE_TAGS = {
  firms: "shared-firms",
  internships: "shared-internships",
  interviewQuestions: "shared-interview-questions",
  news: "shared-news",
} as const;

/**
 * Next's unstable_cache, usable anywhere the shared queries run.
 *
 * Inside the app (a request, a render) it is the Data Cache as above. Outside
 * it - the test suite, the crawl and pipeline scripts, a one-off tsx script -
 * Next has no cache to hand it and unstable_cache throws "Invariant:
 * incrementalCache missing", which on 30 September 2026 broke every test and
 * script that read firms, postings, news or interview questions through these
 * helpers. There the query simply runs uncached; no other error is swallowed.
 */
export function sharedCache<Args extends unknown[], Result>(
  query: (...args: Args) => Promise<Result>,
  keyParts: string[],
  options: { revalidate: number; tags: string[] },
): (...args: Args) => Promise<Result> {
  const cached = unstable_cache(query, keyParts, options);
  return async (...args: Args) => {
    try {
      return await cached(...args);
    } catch (err) {
      if (err instanceof Error && err.message.includes("incrementalCache missing")) return query(...args);
      throw err;
    }
  };
}
