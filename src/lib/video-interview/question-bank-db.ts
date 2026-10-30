import "server-only";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { interviewQuestions } from "@/db/schema";
import { SHARED_CACHE_SECONDS, SHARED_CACHE_TAGS, sharedCache } from "@/lib/shared-data-cache";

/**
 * The video coach's question bank, in the database (interview_questions).
 *
 * Runtime reads go through the functions below and nowhere else. They select
 * NAMED columns, never the whole row, so `expected_points` - the answer key -
 * leaves the database in exactly one place: expectedPointsFor(), at grading
 * time, on the server.
 *
 * The authored bank in src/lib/question-bank/data is only the seed input: see
 * seed.ts and scripts/seed-interview-questions.ts.
 */

type Db = Awaited<ReturnType<typeof getDb>>;

/** A question as selection sees it - everything except the answer key. */
export type BankCandidate = {
  id: string;
  kind: "behavioral" | "technical";
  prompt: string;
  topic: string;
  category: string | null;
  specialty: string | null;
  difficulty: "foundational" | "intermediate" | "advanced";
  rotationPriority: number;
};

const CANDIDATE_COLUMNS = {
  id: interviewQuestions.id,
  kind: interviewQuestions.kind,
  prompt: interviewQuestions.prompt,
  topic: interviewQuestions.topic,
  category: interviewQuestions.category,
  specialty: interviewQuestions.specialty,
  difficulty: interviewQuestions.difficulty,
  rotationPriority: interviewQuestions.rotationPriority,
};

async function db(given?: Db): Promise<Db> {
  return given ?? getDb();
}

/** The active behavioral core, in rotation order (the anchor first). */
async function queryBehavioralCore(given?: Db): Promise<BankCandidate[]> {
  const rows = await (await db(given))
    .select(CANDIDATE_COLUMNS)
    .from(interviewQuestions)
    .where(and(eq(interviewQuestions.kind, "behavioral"), eq(interviewQuestions.isBehavioralCore, true), eq(interviewQuestions.active, true)))
    .orderBy(asc(interviewQuestions.rotationPriority), asc(interviewQuestions.id));
  return rows as BankCandidate[];
}

const cachedBehavioralCore = sharedCache(queryBehavioralCore, ["video-question-bank-behavioral-v1"], {
  revalidate: SHARED_CACHE_SECONDS.reference,
  tags: [SHARED_CACHE_TAGS.interviewQuestions],
});

export async function loadBehavioralCore(given?: Db): Promise<BankCandidate[]> {
  // Explicit handles are used by transactions and tests and must observe that
  // exact database state, so only ordinary runtime reads use the shared cache.
  return given ? queryBehavioralCore(given) : cachedBehavioralCore();
}

/** Every active technical question in the given sectors. */
async function queryTechnicalCandidates(categories: readonly string[], given?: Db): Promise<BankCandidate[]> {
  if (categories.length === 0) return [];
  const rows = await (await db(given))
    .select(CANDIDATE_COLUMNS)
    .from(interviewQuestions)
    .where(and(eq(interviewQuestions.kind, "technical"), eq(interviewQuestions.active, true), inArray(interviewQuestions.category, [...categories])))
    .orderBy(asc(interviewQuestions.id));
  return rows as BankCandidate[];
}

const cachedTechnicalCandidates = sharedCache(
  (categories: string[]) => queryTechnicalCandidates(categories),
  ["video-question-bank-technical-v1"],
  {
    revalidate: SHARED_CACHE_SECONDS.reference,
    tags: [SHARED_CACHE_TAGS.interviewQuestions],
  },
);

export async function loadTechnicalCandidates(categories: readonly string[], given?: Db): Promise<BankCandidate[]> {
  if (given) return queryTechnicalCandidates(categories, given);
  // Sector order does not change the result. Canonicalising it prevents two
  // cache entries for [IB, PE] and [PE, IB].
  return cachedTechnicalCandidates([...new Set(categories)].sort());
}

/** The last-resort pool when a sector runs thin: investment banking's general
 *  technicals, which every finance first round draws on. */
async function queryFallbackTechnical(given?: Db): Promise<BankCandidate[]> {
  const rows = await (await db(given))
    .select(CANDIDATE_COLUMNS)
    .from(interviewQuestions)
    .where(
      and(
        eq(interviewQuestions.kind, "technical"),
        eq(interviewQuestions.active, true),
        eq(interviewQuestions.category, "investment_banking"),
        isNull(interviewQuestions.specialty),
      ),
    )
    .orderBy(asc(interviewQuestions.id));
  return rows as BankCandidate[];
}

const cachedFallbackTechnical = sharedCache(queryFallbackTechnical, ["video-question-bank-fallback-v1"], {
  revalidate: SHARED_CACHE_SECONDS.reference,
  tags: [SHARED_CACHE_TAGS.interviewQuestions],
});

export async function loadFallbackTechnical(given?: Db): Promise<BankCandidate[]> {
  return given ? queryFallbackTechnical(given) : cachedFallbackTechnical();
}

/**
 * The answer key for one question - SERVER-SIDE ONLY, called by grading.
 * Inactive questions still resolve: a question asked before it was retired
 * must still be gradable. Null if the id is unknown or the key is malformed.
 */
async function queryExpectedPoints(bankId: string, given?: Db): Promise<string[] | null> {
  const [row] = await (await db(given))
    .select({ expectedPoints: interviewQuestions.expectedPoints })
    .from(interviewQuestions)
    .where(eq(interviewQuestions.id, bankId))
    .limit(1);
  const pts = row?.expectedPoints;
  return Array.isArray(pts) && pts.every((p) => typeof p === "string") ? pts : null;
}

const cachedExpectedPoints = sharedCache(queryExpectedPoints, ["video-question-bank-answer-v1"], {
  revalidate: SHARED_CACHE_SECONDS.reference,
  tags: [SHARED_CACHE_TAGS.interviewQuestions],
});

export async function expectedPointsFor(bankId: string, given?: Db): Promise<string[] | null> {
  return given ? queryExpectedPoints(bankId, given) : cachedExpectedPoints(bankId);
}

/** How much of the bank can be served - readiness uses this. */
async function queryServableCounts(given?: Db): Promise<{ core: number; technical: number }> {
  const [row] = await (await db(given))
    .select({
      core: sql<number>`(count(*) filter (where ${interviewQuestions.isBehavioralCore} and ${interviewQuestions.kind} = 'behavioral'))::int`,
      technical: sql<number>`(count(*) filter (where ${interviewQuestions.kind} = 'technical'))::int`,
    })
    .from(interviewQuestions)
    .where(eq(interviewQuestions.active, true));
  return { core: Number(row?.core ?? 0), technical: Number(row?.technical ?? 0) };
}

const cachedServableCounts = sharedCache(queryServableCounts, ["video-question-bank-counts-v1"], {
  revalidate: SHARED_CACHE_SECONDS.reference,
  tags: [SHARED_CACHE_TAGS.interviewQuestions],
});

export async function servableCounts(given?: Db): Promise<{ core: number; technical: number }> {
  return given ? queryServableCounts(given) : cachedServableCounts();
}
