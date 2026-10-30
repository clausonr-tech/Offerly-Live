// The Help assistant's rules that need no model, no database and no session:
// how many questions a student may send and when, what a day of answers costs,
// and what a well-formed conversation looks like.
//
// Pure on purpose, so every edge (the 60-second window, the budget boundary, a
// forged history) is unit-tested offline - see scripts/test/help-assistant*.
// The database side (counting ai_usage rows) lives in lib/ai-runner and hands
// its counts to decideHelpGate.

/**
 * The limits. A student can ask as many questions as they like over a day -
 * these only stop a script, not a person:
 *
 *   - one question in flight at a time (the send button is disabled while
 *     waiting, so only a script ever hits this)
 *   - six per rolling minute, which is faster than anyone reads the answers
 *   - 150 per student per day, which no real student reaches
 *   - a GLOBAL budget in dollars per day across every student, so a crowd of
 *     scripts still cannot run up more than that. Over it, the assistant asks
 *     everyone to come back tomorrow.
 *
 * None of this counts toward DAILY_LIMITS in lib/model-registry.
 */
export const HELP_LIMITS = {
  perMinute: 6,
  windowMs: 60_000,
  perDay: 150,
  defaultDailyBudgetUsd: 10,
} as const;

/**
 * Claude Haiku 5.5, US dollars per million tokens. The only model the
 * assistant runs on, and the bottom of FALLBACK_CHAIN, so no row can cost
 * more than this.
 *
 * Was Haiku 4.5's $1 / $5 until 12 October 2026. These two numbers are what
 * HELP_ASSISTANT_DAILY_BUDGET_USD is spent against, so leaving them behind a
 * model move would have priced every row at ten times what it costs and shut
 * students out of the assistant ten times too early.
 *
 * 5.5 is tiered - $0.10 / $0.50 up to a 100K-token prompt, $0.50 / $2.50
 * beyond. The assistant sends one knowledge file and a short question, which
 * is nowhere near 100K, so the lower tier is the right one here.
 */
const HAIKU_PRICE_PER_MTOK = { input: 0.1, output: 0.5 } as const;

/** Cache pricing relative to plain input: writes cost 1.25x, reads 0.1x (5-minute cache). */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** How much conversation reaches the model, and how long each message may be. */
export const HELP_MAX_MESSAGES = 12;
export const HELP_MAX_CHARS = 1000;
/** The whole conversation's ceiling, which the two above imply: 12 turns of
 *  1000 characters. Stated as a constant because it is the number that bounds
 *  what one question can cost, and the merge step has to respect it too. */
export const HELP_MAX_TOTAL_CHARS = HELP_MAX_MESSAGES * HELP_MAX_CHARS;

export type HelpGateReason = "busy" | "burst" | "daily" | "budget";

export type HelpGateInput = {
  /** This student already has a question being answered on this server. */
  inFlight: boolean;
  /** Their questions answered in the last 60 seconds. */
  lastMinute: number;
  /** Their questions answered since midnight. */
  today: number;
  /** What every student's questions have cost today, in dollars. */
  globalSpendUsd: number;
  /** Today's budget for all students together, in dollars. */
  budgetUsd: number;
};

export type HelpGateVerdict = { ok: true } | { ok: false; reason: HelpGateReason; message: string };

export const HELP_LIMIT_MESSAGES: Record<HelpGateReason, string> = {
  busy: "One sec! I'm still working on your last question. I'll be ready for the next one right after.",
  burst: "Whoa, you're quick! Give me about a minute to catch my breath, then ask away.",
  daily: "You've asked a ton today, love the energy! I'm resting up now. Come back tomorrow and we'll keep going.",
  budget: "I've been super busy helping students today and I'm out of answers for now. Please come back tomorrow!",
};

/**
 * Whether a question may go to the model, checked in order of cheapness to
 * explain: a question already in flight, then the minute window, then the
 * student's day, then everyone's budget.
 */
export function decideHelpGate(input: HelpGateInput): HelpGateVerdict {
  const refuse = (reason: HelpGateReason): HelpGateVerdict => ({ ok: false, reason, message: HELP_LIMIT_MESSAGES[reason] });
  if (input.inFlight) return refuse("busy");
  if (input.lastMinute >= HELP_LIMITS.perMinute) return refuse("burst");
  if (input.today >= HELP_LIMITS.perDay) return refuse("daily");
  if (!(input.globalSpendUsd < input.budgetUsd)) return refuse("budget");
  return { ok: true };
}

/**
 * Today's global budget from HELP_ASSISTANT_DAILY_BUDGET_USD. Anything that is
 * not a finite, non-negative number falls back to the default rather than to
 * "unlimited" - a typo in the environment must never remove the ceiling. Zero
 * is honoured and switches the assistant off.
 */
export function dailyBudgetUsd(raw: string | undefined | null): number {
  if (raw == null || raw.trim() === "") return HELP_LIMITS.defaultDailyBudgetUsd;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : HELP_LIMITS.defaultDailyBudgetUsd;
}

export type UsageLike = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/**
 * Input tokens as they are BILLED, in plain-input units.
 *
 * The API's input_tokens excludes cached tokens, so recording it alone would
 * make a cached 20k-token knowledge block look free and let the global budget
 * drift far below real spend. Cache writes bill at 1.25x input and reads at
 * 0.1x, so the cost-equivalent count is input + 1.25 x writes + 0.1 x reads.
 * Stored in ai_usage.input_tokens for Help assistant rows, which is what lets
 * the budget be summed straight from the table.
 */
export function costEquivalentInputTokens(usage: UsageLike): number {
  const write = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  return Math.round((usage.input_tokens ?? 0) + CACHE_WRITE_MULTIPLIER * write + CACHE_READ_MULTIPLIER * read);
}

/** Dollars for a count of (cost-equivalent) input and output tokens at Haiku 5.5 rates. */
export function helpSpendUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * HAIKU_PRICE_PER_MTOK.input + outputTokens * HAIKU_PRICE_PER_MTOK.output) / 1_000_000;
}

/**
 * The questions currently being answered, one per student.
 *
 * In-process, so it holds per server instance: two instances could each run
 * one question for the same student at once. That is fine, but only because
 * the minute window, the daily ceiling and the budget are RESERVED in the
 * database before the model is called (lib/help-gate) - they hold across
 * instances; this guard does not. The chat also disables its send button
 * while it waits, so only a script ever reaches either.
 */
export class InFlightGuard {
  private readonly ids = new Set<string>();

  /** Claims the slot for this student. False when they already hold it. */
  claim(userId: string): boolean {
    if (this.ids.has(userId)) return false;
    this.ids.add(userId);
    return true;
  }

  release(userId: string): void {
    this.ids.delete(userId);
  }

  has(userId: string): boolean {
    return this.ids.has(userId);
  }

  get size(): number {
    return this.ids.size;
  }
}

/** The student's first name, for the greeting. Empty when there is nothing usable. */
export function firstNameOf(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[\p{L}][\p{L}'’.-]{0,39}$/u.test(first) ? first : "";
}

/** The fixed opening message. No model call: it greets before the student asks anything. */
export function helpGreeting(name: string | null | undefined): string {
  const first = firstNameOf(name);
  return (
    `Hey${first ? ` ${first}` : ""}! So glad you're here. I'm your Offerly helper, and I'd love to help you land that offer.\n` +
    "- Ask me how any part of Offerly works\n" +
    "- Or anything about recruiting and interviews\n" +
    "- Ask as many questions as you like!"
  );
}

export const HELP_STARTERS = [
  "How do I find firms to target?",
  "How do I write a networking email?",
  "Where do I practice interview questions?",
  "What should I do first?",
] as const;

export type HelpMessage = { role: "user" | "assistant"; content: string };

export type HelpHistoryResult = { ok: true; messages: HelpMessage[] } | { ok: false; error: string };

export const HELP_INPUT_ERRORS = {
  shape: "Something went wrong sending that. Refresh the page and try again?",
  empty: "Type a question first and I'll jump right on it!",
  tooLong: `That's a long one! Keep it under ${HELP_MAX_CHARS} characters and I'll dig in.`,
  notQuestion: "Ask me a question and I'll answer it!",
} as const;

/**
 * The conversation as the model will see it, from whatever the browser sent.
 *
 * The browser is not trusted: anything could arrive. The newest message must
 * be the student's and within HELP_MAX_CHARS; older messages are kept only if
 * well formed, cut to HELP_MAX_CHARS, and the whole thing to the last
 * HELP_MAX_MESSAGES. Runs of one role are merged so roles alternate, and the
 * conversation always opens on the student.
 *
 * The merge is capped, which is not a detail: cutting each message to
 * HELP_MAX_CHARS and only then joining runs of one role meant 199 forged
 * 1000-character messages collapsed into ONE turn of ~200k characters, which
 * then survived the last-HELP_MAX_MESSAGES slice because it was a single
 * element. That is ~16x the ceiling these numbers describe, on a feature whose
 * per-question count and shared daily budget are calibrated to it. A merged
 * turn is cut back to HELP_MAX_CHARS, keeping its END - the newest text in the
 * run, which for the final turn is the question actually being asked - so the
 * whole conversation can never exceed HELP_MAX_TOTAL_CHARS.
 */
export function validateHelpHistory(input: unknown): HelpHistoryResult {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: HELP_INPUT_ERRORS.shape };
  if (input.length > 200) return { ok: false, error: HELP_INPUT_ERRORS.shape };

  const latest = input[input.length - 1] as unknown;
  if (!isMessage(latest)) return { ok: false, error: HELP_INPUT_ERRORS.shape };
  if (latest.role !== "user") return { ok: false, error: HELP_INPUT_ERRORS.notQuestion };
  const question = latest.content.trim();
  if (!question) return { ok: false, error: HELP_INPUT_ERRORS.empty };
  if (question.length > HELP_MAX_CHARS) return { ok: false, error: HELP_INPUT_ERRORS.tooLong };

  const earlier: HelpMessage[] = [];
  for (const m of input.slice(0, -1)) {
    if (!isMessage(m)) continue;
    const content = m.content.trim().slice(0, HELP_MAX_CHARS);
    if (content) earlier.push({ role: m.role, content });
  }

  const merged: HelpMessage[] = [];
  for (const m of [...earlier, { role: "user" as const, content: question }]) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      // Cut on every join rather than once at the end, so a long run never
      // builds a huge string in memory on the way to being thrown away.
      prev.content = `${prev.content}\n\n${m.content}`.slice(-HELP_MAX_CHARS);
    } else merged.push({ ...m });
  }

  let kept = merged.slice(-HELP_MAX_MESSAGES);
  while (kept.length && kept[0].role !== "user") kept = kept.slice(1);
  return { ok: true, messages: kept };
}

/**
 * The conversation as labelled fields for blockedLanguageError. Every message,
 * not just the newest: the history comes from the browser, and nothing stops
 * a script from rewriting earlier turns before they reach the model.
 */
export function helpLanguageFields(messages: HelpMessage[]): [label: string, value: string][] {
  return messages.map((m) => [m.role === "user" ? "Your question" : "An earlier reply", m.content]);
}

function isMessage(m: unknown): m is HelpMessage {
  if (!m || typeof m !== "object") return false;
  const { role, content } = m as { role?: unknown; content?: unknown };
  return (role === "user" || role === "assistant") && typeof content === "string";
}
