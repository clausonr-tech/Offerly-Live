import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import type { PracticeQuestion } from "@/lib/practice-session";

// A practice question travels to the browser and comes back to be graded. The
// grade is only as good as the question it is graded against: a browser that
// sent back its own `correctOption` or `expectedPoints` could mark any answer
// right and build a streak that shows on the public feed. So every question
// is sealed when it is served - an HMAC over its gradable fields, the student
// and the time - and grading refuses anything whose seal does not match.
//
// A valid seal is also single-use in effect: grading records the time it was
// served and only moves forward (claimSeal), so a question whose answer is
// now known cannot be submitted again for another point on the streak.
//
// The answer key never reaches the browser in the clear. A served question
// has its correctOption and expectedPoints blanked and carries them in
// `hidden`, encrypted to this student and this serving - so a script cannot
// read the right option off the question and answer every one correctly.
// Grading decrypts them and checks the seal over the whole, restored question.
//
// And a round's score is the server's, not the browser's: every graded answer
// returns a signed receipt (issueReceipt), and a finished round is tallied
// from those receipts alone (tallyReceipts).

const SEAL_MAX_AGE_MS = 6 * 60 * 60 * 1000;

let key: Buffer | null = null;
function sealKey(): Buffer {
  if (key) return key;
  // A dedicated key when one is set; otherwise one derived from the server's
  // own archive secret. Hashed with a label, so the source is never exposed and
  // the derived key is useless for anything but this. ANTHROPIC_API_KEY is
  // deliberately NOT a source: it is not an encryption key, and rotating it -
  // which happens on its own schedule - must never silently break grading.
  const material = process.env.PRACTICE_SEAL_KEY || process.env.EMAIL_ARCHIVE_KEY || null;
  if (!material && (process.env.NODE_ENV === "production" || process.env.VERCEL)) {
    // Seals are short-lived (SEAL_MAX_AGE_MS), so an ephemeral key only costs
    // in-flight questions a re-draw - not a security hole - but it should be
    // visible that a dedicated key was expected here.
    console.warn("[practice-seal] no PRACTICE_SEAL_KEY or EMAIL_ARCHIVE_KEY set; using an ephemeral key (valid until restart)");
  }
  key = material
    ? createHash("sha256").update(`offerly:practice-seal:${material}`).digest()
    : randomBytes(32); // no secret at all (a local copy): valid until restart
  return key;
}

/** For tests: forget the cached seal key after changing the environment. */
export function resetPracticeSealKeyForTests() {
  key = null;
}

function gradable(q: PracticeQuestion): string {
  return JSON.stringify([
    q.format ?? null,
    q.options ?? null,
    q.correctOption ?? null,
    q.kind,
    q.topic,
    q.category ?? null,
    q.difficulty,
    q.prompt,
    q.expectedPoints,
  ]);
}

function mac(userId: string, issuedAt: number, q: PracticeQuestion): string {
  return createHmac("sha256", sealKey()).update(`${userId}\n${issuedAt}\n${gradable(q)}`).digest("base64url");
}

// A separate key for each job, derived with its own label, so a seal can
// never be replayed as a receipt or the other way round.
function subKey(label: string): Buffer {
  return createHash("sha256").update(sealKey()).update(`\n${label}`).digest();
}

type AnswerKey = { correctOption: string | null; expectedPoints: string[] };

function encryptKey(userId: string, issuedAt: number, k: AnswerKey): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", subKey("answer-key"), iv);
  cipher.setAAD(Buffer.from(`${userId}\n${issuedAt}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(k), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function decryptKey(userId: string, issuedAt: number, hidden: string): AnswerKey | null {
  try {
    const raw = Buffer.from(hidden, "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", subKey("answer-key"), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${userId}\n${issuedAt}`));
    decipher.setAuthTag(raw.subarray(12, 28));
    const k = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
    if (!k || !Array.isArray(k.expectedPoints) || !k.expectedPoints.every((p: unknown) => typeof p === "string")) return null;
    if (k.correctOption !== null && typeof k.correctOption !== "string") return null;
    return k as AnswerKey;
  } catch {
    return null;
  }
}

/**
 * The question as the browser receives it: sealed, with its answer key
 * blanked and carried encrypted in `hidden`.
 */
export function sealQuestion(userId: string, q: PracticeQuestion, now: Date = new Date()): PracticeQuestion {
  const issuedAt = now.getTime();
  const { correctOption, expectedPoints, ...rest } = q;
  return {
    ...rest,
    expectedPoints: [],
    seal: `${issuedAt}.${mac(userId, issuedAt, q)}`,
    hidden: encryptKey(userId, issuedAt, { correctOption: correctOption ?? null, expectedPoints }),
  };
}

/**
 * The full question behind a served one - answer key restored - if its seal
 * is this student's, intact and recent; null otherwise. A browser that fills
 * in its own answer key is refused rather than ignored.
 */
export function unsealQuestion(
  userId: string,
  q: PracticeQuestion,
  now: Date = new Date(),
): { issuedAt: Date; question: PracticeQuestion } | null {
  const [at, sig] = (q.seal ?? "").split(".");
  const issuedAt = Number(at);
  if (!sig || !Number.isSafeInteger(issuedAt)) return null;
  if (issuedAt > now.getTime() + 60_000 || now.getTime() - issuedAt > SEAL_MAX_AGE_MS) return null;
  if (q.correctOption !== undefined || (q.expectedPoints ?? []).length > 0) return null;
  const k = decryptKey(userId, issuedAt, q.hidden ?? "");
  if (!k) return null;
  const question: PracticeQuestion = {
    format: q.format,
    options: q.options,
    kind: q.kind,
    topic: q.topic,
    category: q.category,
    difficulty: q.difficulty,
    prompt: q.prompt,
    expectedPoints: k.expectedPoints,
    ...(k.correctOption !== null ? { correctOption: k.correctOption } : {}),
  };
  const want = Buffer.from(mac(userId, issuedAt, question));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return { issuedAt: new Date(issuedAt), question };
}

/** When the question was served, if its seal is this student's and intact; null otherwise. */
export function openSeal(userId: string, q: PracticeQuestion, now: Date = new Date()): Date | null {
  return unsealQuestion(userId, q, now)?.issuedAt ?? null;
}

// ------------------------------------------------------------------ receipts

/** A graded answer, as the round tally counts it. */
export type Receipt = { issuedAt: number; points: number; passed: boolean };

function receiptMac(userId: string, r: Receipt): string {
  return createHmac("sha256", subKey("receipt"))
    .update(`${userId}\n${r.issuedAt}\n${r.points}\n${r.passed ? 1 : 0}`)
    .digest("base64url");
}

/** Proof that the question served at `issuedAt` was graded, and how it scored. */
export function issueReceipt(userId: string, issuedAt: Date, points: number, passed: boolean): string {
  const r: Receipt = { issuedAt: issuedAt.getTime(), points: Math.max(0, Math.min(10, Math.round(points))), passed };
  return `${r.issuedAt}.${r.points}.${r.passed ? 1 : 0}.${receiptMac(userId, r)}`;
}

function readReceipt(userId: string, raw: unknown): Receipt | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const [at, pts, ok, sig] = raw.split(".");
  const r: Receipt = { issuedAt: Number(at), points: Number(pts), passed: ok === "1" };
  if (!sig || !Number.isSafeInteger(r.issuedAt) || !Number.isInteger(r.points) || (ok !== "0" && ok !== "1")) return null;
  const want = Buffer.from(receiptMac(userId, r));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? r : null;
}

/**
 * A finished round, worked out from its receipts and nothing the browser
 * claims: the score is the points of the answers actually graded, the best
 * streak their longest run of passes.
 *
 * Only receipts for questions served after `since` (the student's previous
 * saved round) and within the seal's lifetime count, each question once and
 * at most a round's worth - so a receipt cannot be spent in two rounds, and a
 * round cannot be padded past its length.
 */
export function tallyReceipts(
  userId: string,
  receipts: unknown,
  since: Date | null,
  roundLength: number,
  now: Date = new Date(),
): { score: number; questionsAnswered: number; bestStreak: number } | null {
  if (!Array.isArray(receipts)) return null;
  const byQuestion = new Map<number, Receipt>();
  for (const raw of receipts.slice(0, roundLength * 4)) {
    const r = readReceipt(userId, raw);
    if (!r) continue;
    if (since && r.issuedAt <= since.getTime()) continue;
    if (r.issuedAt > now.getTime() + 60_000 || now.getTime() - r.issuedAt > SEAL_MAX_AGE_MS) continue;
    byQuestion.set(r.issuedAt, r);
  }
  const counted = [...byQuestion.values()].sort((a, b) => a.issuedAt - b.issuedAt).slice(0, roundLength);
  if (counted.length === 0) return null;
  let run = 0;
  let bestStreak = 0;
  for (const r of counted) {
    run = r.passed ? run + 1 : 0;
    bestStreak = Math.max(bestStreak, run);
  }
  return {
    score: counted.reduce((sum, r) => sum + r.points, 0),
    questionsAnswered: counted.length,
    bestStreak,
  };
}

/**
 * Records that the question served at `issuedAt` has been graded, and says
 * whether it may be: only a question served after the last one graded. One
 * conditional update, so two submissions of the same question racing in
 * cannot both pass.
 */
export async function claimSeal(userId: string, issuedAt: Date): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(users)
    .set({ practiceLastSealedAt: issuedAt })
    .where(and(eq(users.id, userId), or(isNull(users.practiceLastSealedAt), lt(users.practiceLastSealedAt, issuedAt))))
    .returning();
  return rows.length > 0;
}

/**
 * Gives a claimed question back after grading failed (the model was busy),
 * so the student can submit it again - unless a newer question has been
 * graded since.
 */
export async function releaseSeal(userId: string, issuedAt: Date): Promise<void> {
  const db = await getDb();
  await db
    .update(users)
    .set({ practiceLastSealedAt: new Date(issuedAt.getTime() - 1) })
    .where(and(eq(users.id, userId), eq(users.practiceLastSealedAt, issuedAt)));
}
