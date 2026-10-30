/**
 * Turns captured training examples into the file formats a fine-tune actually
 * consumes, and splits them into train and test sets.
 *
 * Deliberately NOT marked "server-only": this is imported by scripts running
 * outside Next as well as by anything in-app, and the server-only guard throws
 * in a plain tsx process.
 */

export type TaskName = "email_draft" | "resume_tailor";

export type ExampleRow = {
  id: string;
  /** Whose writing this came from - the export keeps only students opted in to Training Use. */
  userId?: string;
  task: TaskName;
  outcome: "accepted" | "edited" | "delivered" | "discarded";
  policyVersion: string;
  promptContext: unknown;
  modelOutput: unknown;
  humanOutput: unknown;
  gotReply: boolean | null;
};

/**
 * The instruction the model is being trained to follow. Kept here, versioned
 * with the code, rather than written fresh at export time: a fine-tune is only
 * reproducible if the system prompt that produced the dataset is recoverable
 * alongside it.
 */
const SYSTEM_PROMPT: Record<TaskName, string> = {
  email_draft:
    "You write cold outreach emails for students recruiting into finance. " +
    "Be specific and brief, make one clear ask, and never invent facts about " +
    "the student - mark anything you do not know rather than filling it in. " +
    "Identifiers appear as placeholders like [CONTACT] and [FIRM]; keep them.",
  resume_tailor:
    "You tailor finance students' resumes. Return the same structure you were " +
    "given, rewriting bullets to be specific and quantified without inventing " +
    "experience. Identifiers appear as placeholders; keep them.",
};

/** One line of a chat-format SFT file. */
export type SftLine = {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
};

/** One line of a preference file. */
export type DpoLine = { prompt: string; chosen: string; rejected: string };

/**
 * Normalises line endings before anything is written out.
 *
 * Textareas submit \r\n and the model returns \n, so without this every
 * example captured from a human edit differs from the model's version on every
 * single line - which a diff-based metric reads as "rewrote everything" and a
 * tokenizer reads as different tokens. It is the cheapest possible correction
 * and it silently ruins the data if skipped.
 *
 * It has to run on the strings INSIDE the value, before serialisation. Running
 * it on the JSON afterwards does nothing at all: by then the carriage returns
 * are escaped as the two characters \ and r, which no longer match. That bug
 * ships silently - the export succeeds and every line of every captured edit
 * is subtly wrong.
 */
function normaliseDeep<T>(value: T): T {
  if (typeof value === "string") return value.replace(/\r\n/g, "\n").trim() as T;
  if (Array.isArray(value)) return value.map(normaliseDeep) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normaliseDeep(v);
    return out as T;
  }
  return value;
}

function render(value: unknown): string {
  const clean = normaliseDeep(value);
  if (typeof clean === "string") return clean;
  return JSON.stringify(clean, null, 2);
}

function promptFor(row: ExampleRow): string {
  return render(row.promptContext);
}

/**
 * What the student ended up with: their edit when they made one, and the
 * model's own text when they accepted it unchanged. Both are targets worth
 * training on - "the model got this right" is a positive example, not an
 * absence of one.
 */
function targetOutput(row: ExampleRow): string {
  return render(row.humanOutput ?? row.modelOutput);
}

export function toSft(row: ExampleRow): SftLine {
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT[row.task] },
      { role: "user", content: promptFor(row) },
      { role: "assistant", content: targetOutput(row) },
    ],
  };
}

/**
 * A preference pair, or null when the row cannot produce one.
 *
 * Only edited examples can: a pair needs something the human preferred AND
 * something they rejected, and an accepted draft has no rejected side. This is
 * the single biggest constraint on preference training here, and it is why the
 * corpus will always hold more SFT lines than DPO pairs.
 */
export function toDpo(row: ExampleRow): DpoLine | null {
  if (row.humanOutput == null) return null;
  const chosen = render(row.humanOutput);
  const rejected = render(row.modelOutput);
  if (chosen === rejected) return null;
  return { prompt: promptFor(row), chosen, rejected };
}

/**
 * Deterministic hash, used for the train/test split.
 *
 * The split MUST be stable across runs. If it were random, every export would
 * reshuffle which examples are held out, and any measured improvement between
 * two fine-tunes could just be an easier test set - the comparison would be
 * meaningless while looking perfectly rigorous. Hashing the row's own id fixes
 * an example's side for as long as it exists.
 */
function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export function isHeldOut(id: string, testFraction: number): boolean {
  return hash(id) < testFraction;
}

export type CorpusStats = {
  total: number;
  byTask: Record<string, number>;
  byOutcome: Record<string, number>;
  byPolicyVersion: Record<string, number>;
  /** Rows that can produce a preference pair. */
  dpoEligible: number;
  withReplyLabel: number;
};

export function summarise(rows: ExampleRow[]): CorpusStats {
  const stats: CorpusStats = {
    total: rows.length,
    byTask: {},
    byOutcome: {},
    byPolicyVersion: {},
    dpoEligible: 0,
    withReplyLabel: 0,
  };
  for (const row of rows) {
    stats.byTask[row.task] = (stats.byTask[row.task] ?? 0) + 1;
    stats.byOutcome[row.outcome] = (stats.byOutcome[row.outcome] ?? 0) + 1;
    stats.byPolicyVersion[row.policyVersion] =
      (stats.byPolicyVersion[row.policyVersion] ?? 0) + 1;
    if (toDpo(row)) stats.dpoEligible += 1;
    if (row.gotReply !== null) stats.withReplyLabel += 1;
  }
  return stats;
}

/**
 * Roughly how many examples a LoRA on a small open-weight base needs before a
 * fine-tune is worth attempting, per task. Not a hard threshold - a floor
 * below which the exercise is measuring noise.
 */
export const VIABLE_PER_TASK = 500;
