import { z } from "zod";
import { FILLER_LABELS, PAUSE_SEC, tokenize } from "../delivery-metrics";

/**
 * The evaluation manifest: one JSON file listing every fixture the video
 * interview evaluator may use, with the provenance, licence and permitted use
 * of each. Nothing is evaluated that is not in a manifest, and nothing is
 * accepted into a manifest without a licence, a consent basis and a permitted
 * use.
 *
 * Two hard rules are enforced here, not left to reviewers:
 *   - No protected characteristic is ever recorded or inferred. There is no
 *     field for gender, age, ethnicity and the like, unknown keys are
 *     rejected, and an accent may be recorded only when the source dataset
 *     itself supplied it (accentSource "dataset") - never guessed from audio.
 *   - Held-out evaluation data can never be marked for training: Earnings-21
 *     entirely, and the official test/dev partitions of every dataset.
 *
 * Pure: no filesystem, no network. The CLI reads the file and passes it here.
 */

export const RUBRIC_DIMENSIONS = [
  "grammarClarity",
  "pacePauses",
  "fillers",
  "structure",
  "relevance",
  "completeness",
  "logic",
  "concision",
] as const;
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

export const CLASSES = ["strong", "average", "poor"] as const;
export const STAR_ELEMENTS = ["situation", "task", "action", "result", "reflection"] as const;

/** Datasets that are held out for evaluation, always. */
const HELD_OUT_DATASETS = new Set(["earnings21"]);
/** Official partitions that are evaluation-only in any dataset. */
const HELD_OUT_SPLIT = /^(test|dev|validation)([-_].*)?$/i;

/** Keys that must never appear anywhere in a fixture - Offerly does not
 *  record, infer or slice by protected characteristics. */
const FORBIDDEN_KEYS = /^(gender|sex|age|age_?group|race|ethnicity|religion|disability|sexual_?orientation|nationality|pregnancy|marital_?status)$/i;

const score = z.number().min(0).max(100);
const scoresSchema = z
  .object({ ...Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, score])), overall: score } as Record<RubricDimension | "overall", typeof score>)
  .strict();

const reviewSchema = z
  .object({
    /** A pseudonymous reviewer code (e.g. "R1"), never a name. */
    reviewer: z.string().regex(/^[A-Z][A-Z0-9-]{0,15}$/, "reviewer must be a pseudonymous code like R1"),
    /** Reviewers score without seeing each other's scores or any model output. */
    blind: z.literal(true),
    scores: scoresSchema,
    classification: z.enum(CLASSES),
  })
  .strict();

const starSchema = z.object(Object.fromEntries(STAR_ELEMENTS.map((e) => [e, z.boolean()])) as Record<(typeof STAR_ELEMENTS)[number], z.ZodBoolean>).strict();

const manifestItemSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/, "id: lowercase letters, digits, . _ -"),
    source: z
      .object({
        dataset: z.string().min(1),
        /** The dataset's own partition name ("test-clean", "dev", "train"). */
        split: z.string().nullable(),
        originalId: z.string().nullable(),
        attribution: z.string().nullable(),
        /** The dataset release this came from ("v1.0", a commit, a date). */
        version: z.string().nullable(),
        /** Exactly where `license` was established - a URL, file path or
         *  written confirmation, for the media and not only the text. */
        licenseSource: z.string().nullable(),
      })
      .strict(),
    license: z.string().min(1, "license is required"),
    /** Why we may use it: the licence terms, or the recorded consent. */
    consentBasis: z.string().min(1, "consentBasis is required"),
    permittedUse: z.enum(["evaluation", "training", "both"]),
    tasks: z.array(z.enum(["asr", "grader"])).min(1),
    /** Relative to the manifest's directory. Never committed for real audio. */
    mediaPath: z.string().nullable(),
    /** Seconds of speech, for pace. Required to grade. */
    durationSec: z.number().positive().nullable(),
    referenceTranscript: z.string().min(1),
    /**
     * True only when the reference was transcribed VERBATIM, fillers
     * (um, uh, er...) included. The filler metric is reported only for these;
     * most public datasets strip fillers, so they are false.
     */
    verbatimFillers: z.boolean(),
    question: z
      .object({
        prompt: z.string().min(1),
        kind: z.enum(["behavioral", "technical"]),
        sector: z.string().nullable(),
        specialty: z.string().nullable(),
        topic: z.string().min(1),
        difficulty: z.enum(["foundational", "intermediate", "advanced"]),
        /** The grading criteria, as the grader sees them (server-only in the app). */
        expectedPoints: z.array(z.string().min(1)),
      })
      .strict()
      .nullable(),
    expected: z
      .object({
        /** 1-based indices into question.expectedPoints the answer conveys. */
        coveredPoints: z.array(z.number().int().positive()),
        /** Wrong statements in the answer, in the reviewers' words. */
        factualErrors: z.array(z.string()),
        /** Behavioral answers: which STAR elements are present. */
        star: starSchema.nullable(),
      })
      .strict()
      .nullable(),
    reviews: z.array(reviewSchema).nullable(),
    adjudicated: z
      .object({ scores: scoresSchema, classification: z.enum(CLASSES), method: z.string().min(1) })
      .strict()
      .nullable(),
    slices: z
      .object({
        audio: z.enum(["clean", "noisy", "challenging", "unknown"]),
        /** Only as supplied by the dataset itself - never inferred. */
        accent: z.string().nullable(),
        accentSource: z.enum(["dataset", "none"]),
        speakingSpeed: z.enum(["slow", "typical", "fast", "unknown"]),
        answerLength: z.enum(["short", "medium", "long"]),
      })
      .strict(),
    /**
     * Human-verified delivery ground truth, from the RECORDING - never from
     * any model's transcript. Every field is optional; a delivery metric is
     * computed only for items that carry the annotation it needs.
     */
    delivery: z
      .object({
        /** "synthetic" is for the committed test fixtures only. */
        verifiedBy: z.enum(["human", "synthetic"]),
        /** How it was annotated, e.g. "two annotators, Praat, from the audio". */
        method: z.string().min(1),
        /** First word's onset to last word's offset, in seconds. */
        speakingSec: z.number().positive().optional(),
        wordsPerMinute: z.number().positive().optional(),
        /** EVERY silent gap of PAUSE_SEC or more, in recording time. */
        pauses: z.array(z.object({ startSec: z.number().min(0), endSec: z.number().positive() }).strict()).optional(),
        /** Every filler heard, one entry per occurrence, as production labels them. */
        fillers: z.array(z.enum(FILLER_LABELS)).optional(),
        /** Phrases said three or more times, with how often. */
        repeatedPhrases: z.array(z.object({ phrase: z.string().min(1), count: z.number().int().min(3) }).strict()).optional(),
        /** Repeated words ("I I") and cut-off / restarted words ("th- the"). */
        disfluencies: z.array(z.object({ type: z.enum(["repetition", "cutoff"]), text: z.string().min(1) }).strict()).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    annotations: z
      .object({
        financeTerms: z.array(z.string()).optional(),
        namedEntities: z.array(z.string()).optional(),
        numbers: z.array(z.string()).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type ManifestItem = z.infer<typeof manifestItemSchema>;

const manifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    name: z.string().min(1),
    description: z.string().optional(),
    items: z.array(z.unknown()),
  })
  .strict();

export type Manifest = { manifestVersion: 1; name: string; description?: string; items: ManifestItem[] };

export type ValidationResult = { ok: true; manifest: Manifest } | { ok: false; errors: string[] };

function forbiddenKeys(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(k)) found.push(`${path}${k}`);
    found.push(...forbiddenKeys(v, `${path}${k}.`));
  }
  return found;
}

/** Whether a split name is an official test/dev partition. */
function isHeldOutSplit(split: string | null | undefined): boolean {
  return Boolean(split && HELD_OUT_SPLIT.test(split));
}

/** Item-level rules zod cannot express. Returns error strings. */
function itemRules(item: ManifestItem, opts: { requireMedia: boolean }): string[] {
  const e: string[] = [];
  const at = (m: string) => e.push(`${item.id}: ${m}`);
  if (item.slices.accent !== null && item.slices.accentSource !== "dataset") at("accent may only be recorded when the dataset supplied it (accentSource: \"dataset\")");
  if (item.slices.accent === null && item.slices.accentSource === "dataset") at("accentSource is \"dataset\" but no accent is given");
  const heldOut = HELD_OUT_DATASETS.has(item.source.dataset.toLowerCase()) || isHeldOutSplit(item.source.split);
  if (item.source.dataset.toLowerCase() === "earnings21") {
    // Its LICENSE covers the transcripts and alignments; the audio's terms
    // must be confirmed separately, for the specific release.
    if (!item.source.version) at("Earnings-21 items must record the dataset release (source.version)");
    if (!item.source.licenseSource) at("Earnings-21 items must record where the audio licence was confirmed (source.licenseSource)");
  }
  if (heldOut && item.permittedUse !== "evaluation") at(`held-out data (${item.source.dataset}${item.source.split ? `/${item.source.split}` : ""}) must be permittedUse "evaluation"`);
  if (item.mediaPath !== null && (item.mediaPath.startsWith("/") || item.mediaPath.split(/[\\/]/).includes(".."))) at("mediaPath must be relative and stay inside the manifest's directory");
  if (item.tasks.includes("asr") && opts.requireMedia && !item.mediaPath) at("an asr item needs mediaPath for a live run");
  if (item.delivery) e.push(...deliveryRules(item));
  if (item.tasks.includes("grader")) {
    if (!item.question) at("a grader item needs question");
    if (!item.expected) at("a grader item needs expected");
    if (!item.reviews || item.reviews.length < 2) at("a grader item needs at least two blind human reviews, from different reviewers");
    if (!item.adjudicated) at("a grader item needs adjudicated scores");
    if (item.durationSec === null) at("a grader item needs durationSec (pace is scored)");
    if (item.question && item.expected) {
      const n = item.question.expectedPoints.length;
      if (item.expected.coveredPoints.some((i) => i > n)) at("expected.coveredPoints refers past question.expectedPoints");
      if (item.question.kind === "behavioral" && !item.expected.star) at("a behavioral item needs expected.star");
      if (item.question.kind === "technical" && item.expected.star) at("a technical item must have expected.star null");
    }
    const ids = new Set((item.reviews ?? []).map((r) => r.reviewer));
    if (item.reviews && ids.size !== item.reviews.length) at("each reviewer may review an item once");
  }
  return e;
}

/** How far an annotated WPM may sit from words / speakingSec before the two
 *  are treated as contradicting each other. */
const WPM_CONSISTENCY = { relative: 0.15, absolute: 10 } as const;

/**
 * Human delivery annotations, checked for internal consistency. Rejects what
 * can only be an annotation MISTAKE - a reversed or overlapping pause, a pause
 * outside the recording, a speaking time longer than the recording, a WPM that
 * contradicts the speaking time, the same repeated phrase listed twice - and
 * never what is simply a repeated event: the same filler, or the same
 * disfluency, can legitimately occur many times.
 */
function deliveryRules(item: ManifestItem): string[] {
  const d = item.delivery!;
  const e: string[] = [];
  const at = (m: string) => e.push(`${item.id}: delivery.${m}`);
  const dur = item.durationSec;
  const EPS = 1e-6;
  if (dur === null) {
    at("annotations need the item's durationSec");
    return e;
  }
  const pauses = d.pauses ?? [];
  pauses.forEach((p, i) => {
    if (!(p.startSec < p.endSec)) at(`pauses[${i}] runs backwards or has no length (startSec must be < endSec)`);
    else if (p.endSec - p.startSec < PAUSE_SEC - EPS) at(`pauses[${i}] is shorter than ${PAUSE_SEC}s (the production pause threshold)`);
    if (p.startSec < 0 || p.endSec > dur + EPS) at(`pauses[${i}] lies outside the recording (0 to ${dur}s)`);
    if (i > 0) {
      const prev = pauses[i - 1];
      if (p.startSec < prev.startSec) at(`pauses[${i}] is out of chronological order`);
      else if (p.startSec < prev.endSec - EPS) at(`pauses[${i}] overlaps pauses[${i - 1}]`);
    }
  });
  if (d.speakingSec !== undefined && d.speakingSec > dur + EPS) at(`speakingSec (${d.speakingSec}) is longer than the recording (${dur}s)`);
  if (d.speakingSec !== undefined && d.wordsPerMinute !== undefined) {
    const words = tokenize(item.referenceTranscript).length;
    const implied = (words / d.speakingSec) * 60;
    const allowed = Math.max(WPM_CONSISTENCY.absolute, implied * WPM_CONSISTENCY.relative);
    if (Math.abs(d.wordsPerMinute - implied) > allowed) {
      at(`wordsPerMinute (${d.wordsPerMinute}) contradicts ${words} verified words over speakingSec ${d.speakingSec} (implies ~${Math.round(implied)})`);
    }
  }
  const phrases = (d.repeatedPhrases ?? []).map((r) => tokenize(r.phrase).join(" "));
  phrases.forEach((ph, i) => {
    if (phrases.indexOf(ph) !== i) at(`repeatedPhrases lists "${ph}" more than once - give it once, with its count`);
  });
  return e;
}

/**
 * Validates a parsed manifest. Every error is collected - a manifest is
 * fixed in one pass, not one complaint at a time. `requireMedia` is set for
 * live runs, which need the audio; a dry run does not.
 */
export function validateManifest(raw: unknown, opts: { requireMedia?: boolean } = {}): ValidationResult {
  const top = manifestSchema.safeParse(raw);
  if (!top.success) return { ok: false, errors: top.error.issues.map((i) => `manifest.${i.path.join(".")}: ${i.message}`) };
  const errors: string[] = [];
  const items: ManifestItem[] = [];
  const seen = new Set<string>();
  top.data.items.forEach((rawItem, idx) => {
    const label = (rawItem as { id?: unknown })?.id ?? `#${idx}`;
    const bad = forbiddenKeys(rawItem);
    if (bad.length) {
      errors.push(`${String(label)}: protected-characteristic fields are not allowed (${bad.join(", ")})`);
      return;
    }
    const r = manifestItemSchema.safeParse(rawItem);
    if (!r.success) {
      for (const i of r.error.issues) errors.push(`${String(label)}: ${i.path.join(".") || "(item)"}: ${i.message}`);
      return;
    }
    if (seen.has(r.data.id)) errors.push(`${r.data.id}: duplicate id`);
    seen.add(r.data.id);
    errors.push(...itemRules(r.data, { requireMedia: Boolean(opts.requireMedia) }));
    items.push(r.data);
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: { manifestVersion: 1, name: top.data.name, description: top.data.description, items } };
}

/**
 * Whether a fixture may ever be used to TRAIN a model. Only when its manifest
 * explicitly says so, and never for held-out data - whatever the entry says.
 * Nothing in Offerly trains on evaluation fixtures today; this is the gate any
 * future training export must pass through.
 */
export function trainingEligible(item: ManifestItem): boolean {
  if (item.permittedUse === "evaluation") return false;
  if (HELD_OUT_DATASETS.has(item.source.dataset.toLowerCase())) return false;
  if (isHeldOutSplit(item.source.split)) return false;
  return true;
}
