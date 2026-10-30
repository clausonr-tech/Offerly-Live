import "server-only";
import { LOCK_FAMILY } from "@/lib/advisory-locks";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { aiUsage, users } from "@/db/schema";
import { getAnthropicClient, hasAnthropicKey, MissingApiKeyError } from "./anthropic-client";

// Re-exported so callers catch it from the same module they catch
// QuotaExceededError from.
export { MissingApiKeyError };
import { HELP_LIMIT_MESSAGES, InFlightGuard, type HelpGateReason } from "./help-chat-rules";
import { releaseHelpQuestion, reserveHelpQuestion } from "./help-gate";
import {
  DAILY_LIMITS,
  getModelConfig,
  nextFallbackModel,
  supportsAdaptiveThinking,
  supportsEffort,
  supportsFastMode,
  type AiFeature,
  type ModelConfig,
  type Plan,
} from "./model-registry";

// Every AI feature goes through runAiFeature. It owns the three things that
// have to happen on every model call at scale:
//
//   1. Quota   — stop one scripted client draining the budget
//   2. Routing — pick the model for this user's plan (lib/model-registry)
//   3. Fallback — a rate-limited primary degrades to a cheaper model rather
//                 than surfacing an error page
//
// It also records what was actually spent, which is what makes model choice
// tunable later instead of guesswork.

export class QuotaExceededError extends Error {
  constructor(readonly plan: Plan, readonly limit: number) {
    super(
      plan === "free"
        ? `You've used all ${limit} AI actions for today. Upgrade for a higher limit, or try again tomorrow.`
        : `You've hit today's fair-use limit of ${limit} AI actions. It resets at midnight.`,
    );
    this.name = "QuotaExceededError";
  }
}

/**
 * A Help assistant question refused by its own gates (lib/help-chat-rules):
 * one in flight, the minute window, the student's day or the global budget.
 * The message is written for the student.
 */
export class HelpLimitError extends Error {
  constructor(readonly reason: HelpGateReason, message: string) {
    super(message);
    this.name = "HelpLimitError";
  }
}

// Minimal shape we need back from an Anthropic call. Both messages.create and
// messages.parse satisfy this, so features can use either.
type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};
type AnthropicResponse = { usage: Usage };

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Retryable = the model is busy, not the request is wrong. A 400 means our
// payload is broken and falling back to another model won't help.
export function isCapacityError(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.APIError && typeof err.status === "number") {
    return err.status >= 500;
  }
  return err instanceof Anthropic.APIConnectionError;
}

async function getUserPlan(userId: string): Promise<Plan> {
  const db = await getDb();
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { plan: true },
  });
  return (row?.plan as Plan | undefined) ?? "free";
}

// The Help assistant's rows ("chat") are metered by its own gates, never
// against DAILY_LIMITS: asking questions must not cost a student their drafts.
function countsTowardQuota(userId: string) {
  return and(eq(aiUsage.userId, userId), gte(aiUsage.createdAt, startOfToday()), ne(aiUsage.feature, "chat"));
}

/**
 * Takes one of today's calls BEFORE the model is called, and returns the row
 * that holds it. Counted and written under a per-student lock, in one
 * transaction, so requests fired together queue for it: exactly the first
 * ones get through. (Checking the count and recording only after the call
 * let twenty requests started together all pass a 25-a-day check at 24.) The
 * row is filled in with the real model and tokens once the call returns
 * (recordUsage), and removed only if the model was never reached - a call that
 * never happened has never counted, while one that did keeps its row even if
 * the bookkeeping after it fails (see AnsweredFlag).
 */
async function reserveQuota(userId: string, plan: Plan, feature: AiFeature): Promise<string> {
  const db = await getDb();
  const limit = DAILY_LIMITS[plan];
  // One transaction type across the two drivers (PGlite, postgres-js).
  const run = db.transaction.bind(db) as unknown as <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T>;
  const id = await run(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_FAMILY.aiQuota}, hashtext(${`ai-quota:${userId}`}))`);
    const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(aiUsage).where(countsTowardQuota(userId));
    if ((row?.count ?? 0) >= limit) return null;
    const [mine] = await tx
      .insert(aiUsage)
      .values({ userId, feature, model: getModelConfig(feature, plan).model, inputTokens: 0, outputTokens: 0, usedFallback: false, createdAt: new Date() })
      .returning();
    return mine.id;
  });
  if (!id) throw new QuotaExceededError(plan, limit);
  return id;
}

async function releaseQuota(reservationId: string): Promise<void> {
  const db = await getDb();
  await db.delete(aiUsage).where(eq(aiUsage.id, reservationId));
}

async function recordUsage(input: {
  userId: string;
  feature: AiFeature;
  model: string;
  usedFallback: boolean;
  usage: Usage;
  /** The row reserveQuota wrote for this call, filled in rather than added to. */
  reservationId?: string;
}): Promise<void> {
  const db = await getDb();
  if (input.reservationId) {
    await db
      .update(aiUsage)
      .set({
        model: input.model,
        inputTokens: input.usage.input_tokens ?? 0,
        outputTokens: input.usage.output_tokens ?? 0,
        usedFallback: input.usedFallback,
      })
      .where(eq(aiUsage.id, input.reservationId));
    return;
  }
  await db.insert(aiUsage).values({
    userId: input.userId,
    feature: input.feature,
    model: input.model,
    inputTokens: input.usage.input_tokens ?? 0,
    outputTokens: input.usage.output_tokens ?? 0,
    usedFallback: input.usedFallback,
  });
}

/**
 * Whether the model actually answered, read by the handler that would
 * otherwise give the reservation back.
 *
 * WHAT THIS STOPS. recordUsage used to be awaited straight after call()
 * returned, inside the try. A database error there is not a capacity error, so
 * it was rethrown, and the outer handler then DELETED the provisional ai_usage
 * row - the only record that the question happened. The paid call became free
 * and unrecorded, and "the model never answered, so it never counted" could no
 * longer be told apart from "the model answered, we paid, and the write
 * failed". It failed toward more spend and erased the evidence of it.
 *
 * So the flag is set the instant call() resolves, and nothing after that point
 * may release. A reservation is given back only for a question the model
 * never answered.
 */
type AnsweredFlag = { yes: boolean };

// Help assistant questions being answered right now, one per student. Per
// server instance - see InFlightGuard. A courtesy on top of the reservation
// below (lib/help-gate), which is what actually holds across instances.
const helpInFlight = new InFlightGuard();

export async function runAiFeature<T extends AnthropicResponse>(
  opts: {
    feature: AiFeature;
    userId: string;
    /**
     * Which gate the call passes. "general" (the default) is the per-user
     * DAILY_LIMITS quota every feature shares. "help" is the Help assistant's
     * own gates instead - one question in flight, the minute window, a daily
     * ceiling and the global budget - and does not touch DAILY_LIMITS.
     */
    quota?: "general" | "help";
    /**
     * What to store in ai_usage for this call, when the raw usage is not the
     * right record. The Help assistant stores cost-equivalent input tokens so
     * its global budget can be summed from the table.
     */
    meter?: (usage: Usage) => { input_tokens: number; output_tokens: number };
  },
  call: (client: Anthropic, config: ModelConfig) => Promise<T>,
): Promise<T> {
  // Checked before the quota gate, which is the opposite of the hosted
  // product's order (see the note further down where the client is built).
  // There the key is always set, so a configuration error would be a bug and
  // the quota message was the useful one. Self-hosted the key is usually what
  // is missing, and reserving quota first would spend an allowance on a call
  // that cannot be made — and answer "you have reached today's limit" to
  // someone whose real problem is that they never added a key.
  if (!hasAnthropicKey()) throw new MissingApiKeyError();

  if (opts.quota === "help") {
    // Claimed before the first await, so two questions racing in from the same
    // student on THIS instance cannot both pass. The reservation below is what
    // holds when they land on different instances.
    if (!helpInFlight.claim(opts.userId)) throw new HelpLimitError("busy", HELP_LIMIT_MESSAGES.busy);
    let reservationId: string | undefined;
    const answered: AnsweredFlag = { yes: false };
    try {
      const plan = await getUserPlan(opts.userId);
      // Taken under a lock before the model is called, so questions fired
      // together queue for it instead of all reading the same pre-call counts.
      const reserved = await reserveHelpQuestion(opts.userId, getModelConfig(opts.feature, plan).model);
      if (!reserved.ok) throw new HelpLimitError(reserved.reason, reserved.message);
      reservationId = reserved.id;
      return await callWithFallback(opts, plan, call, answered, reservationId);
    } catch (err) {
      // A question the model never answered has never counted. Once it HAS
      // been answered the row stays, whatever went wrong afterwards - see
      // AnsweredFlag.
      if (reservationId && !answered.yes) await releaseHelpQuestion(reservationId).catch(() => {});
      throw err;
    } finally {
      helpInFlight.release(opts.userId);
    }
  }

  const plan = await getUserPlan(opts.userId);
  const reservationId = await reserveQuota(opts.userId, plan, opts.feature);
  const answered: AnsweredFlag = { yes: false };
  try {
    return await callWithFallback(opts, plan, call, answered, reservationId);
  } catch (err) {
    // Same rule on this path: a call that reached the model keeps its row, so
    // the quota it spent is not handed back on a bookkeeping failure.
    if (!answered.yes) await releaseQuota(reservationId).catch(() => {});
    throw err;
  }
}

async function callWithFallback<T extends AnthropicResponse>(
  opts: { feature: AiFeature; userId: string; meter?: (usage: Usage) => { input_tokens: number; output_tokens: number } },
  plan: Plan,
  call: (client: Anthropic, config: ModelConfig) => Promise<T>,
  /** Flipped the moment the model answers, so the caller stops releasing. */
  answered: AnsweredFlag,
  reservationId?: string,
): Promise<T> {
  // Still after the quota gate, but no longer the first thing to notice a
  // missing key: runAiFeature preflights that before reserving anything.
  // This stays as the backstop for any path that reaches here directly.
  const client = getAnthropicClient();
  const base = getModelConfig(opts.feature, plan);

  let model: string | null = base.model;
  // Fast mode has its own, tighter rate limit, so it is the first thing given
  // up: a fast-mode 429 retries the SAME model at standard speed before any
  // rung of the model chain is descended - speed goes before capability.
  let speed = supportsFastMode(base.model) ? base.speed ?? null : null;
  let lastError: unknown;

  // Walk down the fallback chain. Each rung is a strictly cheaper, less
  // contended model, so a capacity spike on Opus degrades to Sonnet and then
  // Haiku instead of failing the user's request.
  while (model) {
    try {
      // Re-resolve effort and thinking for the model actually being used:
      // falling back from a model that accepts them to one that rejects them
      // would otherwise turn a capacity blip into a hard 400.
      const response = await call(client, {
        ...base,
        model,
        effort: supportsEffort(model) ? base.effort : null,
        thinking: supportsAdaptiveThinking(model) ? base.thinking : null,
        speed,
      });

      // BEFORE anything else can throw. The call has been made and billed by
      // the provider; from here on the reservation is a record of real spend
      // and must not be given back. See AnsweredFlag.
      answered.yes = true;

      // Its own try/catch, and the error is swallowed. Filling the row in is
      // bookkeeping that happens AFTER the answer exists: if the database
      // refuses the update, the provisional row is a worse record than the
      // real tokens would have been, but it is still a record - and the
      // student gets the answer they are owed rather than an error for a
      // question that was already paid for. Logged so the undercount is
      // visible rather than silent.
      try {
        await recordUsage({
          userId: opts.userId,
          feature: opts.feature,
          model,
          usedFallback: model !== base.model,
          usage: opts.meter ? opts.meter(response.usage) : response.usage,
          reservationId,
        });
      } catch (err) {
        console.error(
          `[ai-usage] ${opts.feature} answered on ${model} but its usage could not be written` +
            `${reservationId ? ` (reservation ${reservationId} keeps its provisional tokens)` : " (nothing was recorded)"}`,
          err,
        );
      }

      return response;
    } catch (err) {
      if (!isCapacityError(err)) throw err;
      lastError = err;
      if (speed) {
        speed = null;
        continue;
      }
      model = nextFallbackModel(model);
      speed = model && supportsFastMode(model) ? base.speed ?? null : null;
    }
  }

  throw new Error(
    "AI is temporarily at capacity across all models. Please try again in a moment.",
    { cause: lastError },
  );
}

/**
 * A model call made by a background job rather than by a person.
 *
 * Shares runAiFeature's fallback walk - a capacity spike degrades to a cheaper
 * model instead of failing - and deliberately skips the per-user parts. The
 * crawler has no user: there is no plan to resolve, and charging a scripted
 * sweep of every careers page to whoever happened to log in last would empty a
 * real student's quota for work they never asked for.
 *
 * The trade is that background spend is not metered here. That is the right
 * default while the only caller runs a few hundred Haiku extractions per cycle,
 * and the wrong one the moment it grows - when it does, meter it against a
 * system account rather than reinstating per-user quota.
 */
export async function runBackgroundAiFeature<T extends AnthropicResponse>(
  feature: AiFeature,
  call: (client: Anthropic, config: ModelConfig) => Promise<T>,
  // Which plan's routing to use. "free" for the crawler; the offline
  // evaluator (scripts/eval) can ask for "pro" to measure that tier's model.
  plan: Plan = "free",
): Promise<T> {
  // Background work (the crawler's classification, the offline evaluator) has
  // no person watching, so this surfaces in the job's log rather than the UI.
  if (!hasAnthropicKey()) throw new MissingApiKeyError();
  const client = getAnthropicClient();
  const base = getModelConfig(feature, plan);

  let model: string | null = base.model;
  // Background routing uses the free tier, which sets no speed - but resolve
  // it the same way so an eval asking for "pro" walks the same rungs.
  let speed = supportsFastMode(base.model) ? base.speed ?? null : null;
  let lastError: unknown;

  while (model) {
    try {
      return await call(client, {
        ...base,
        model,
        effort: supportsEffort(model) ? base.effort : null,
        thinking: supportsAdaptiveThinking(model) ? base.thinking : null,
        speed,
      });
    } catch (err) {
      if (!isCapacityError(err)) throw err;
      lastError = err;
      if (speed) {
        speed = null;
        continue;
      }
      model = nextFallbackModel(model);
      speed = model && supportsFastMode(model) ? base.speed ?? null : null;
    }
  }

  throw new Error("AI is temporarily at capacity across all models.", { cause: lastError });
}

/**
 * The config for one attempt on `model` in a fallback walk: effort and
 * thinking re-resolved for that model, exactly as callWithFallback does.
 * Exported for the offline evaluator, which walks the same chain itself so it
 * can count every request.
 */
export function attemptConfig(base: ModelConfig, model: string): ModelConfig {
  return {
    ...base,
    model,
    effort: supportsEffort(model) ? base.effort : null,
    thinking: supportsAdaptiveThinking(model) ? base.thinking : null,
    speed: supportsFastMode(model) ? base.speed ?? null : null,
  };
}
