// The video interview coach's shared vocabulary. Client-safe: no server-only
// import, no question bank, no answer keys - the browser imports its labels,
// limits and the shape of what the server sends it from here.

export const INTERVIEW_MODES = ["behavioral", "technical", "both"] as const;
export type InterviewMode = (typeof INTERVIEW_MODES)[number];

export const MODE_LABELS: Record<InterviewMode, string> = {
  behavioral: "Behavioral",
  technical: "Technical",
  both: "Both",
};

export const MODE_BLURBS: Record<InterviewMode, string> = {
  behavioral: "Five fit and experience questions - the core every first round asks.",
  technical: "Five technicals, picked for your sectors and level.",
  both: "Two behavioral, then three technical - like a real first round.",
};

/** Every interview is five questions long, whatever the mode. */
export const QUESTIONS_PER_INTERVIEW = 5;

/** How many of each kind a mode asks, in the order they are asked. */
export const MODE_COMPOSITION: Record<InterviewMode, { behavioral: number; technical: number }> = {
  behavioral: { behavioral: 5, technical: 0 },
  technical: { behavioral: 0, technical: 5 },
  both: { behavioral: 2, technical: 3 },
};

// The think and answer choices the page offered before this rebuild - kept, so
// a student's habit carries over.
export const THINK_OPTIONS = [15, 30, 60] as const;
export const ANSWER_OPTIONS = [60, 120, 180] as const;

/** The last seconds of think time shown as a big 3-2-1. */
export const COUNTDOWN_SECONDS = 3;

export const DIFFICULTY_CHOICES = ["auto", "foundational", "intermediate", "advanced"] as const;
export type DifficultyChoice = (typeof DIFFICULTY_CHOICES)[number];

export const DIFFICULTY_CHOICE_LABELS: Record<DifficultyChoice, string> = {
  auto: "Match my level",
  foundational: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

/**
 * Upload limits for one answer's audio. The browser uploads an audio-only
 * recording (Opus in WebM/Ogg, or AAC in MP4 on Safari) - about 1MB for three
 * minutes - never the video. 4MB is the app's per-file ceiling (lib/file-store)
 * and sits under the server action body limit in next.config.ts.
 */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/**
 * The most a second of answer audio may weigh.
 *
 * 32KB/s is ~256kbit/s - roughly eight times what a browser's Opus recorder
 * produces for speech, so no honest recording comes near it. It exists because
 * MAX_AUDIO_BYTES alone does not bound what the transcription provider BILLS,
 * which is audio minutes: a few hundred kilobytes of low-bitrate audio can be
 * an hour long, and `durationMs` is the browser's claim. Multiplying by the
 * answer time the question actually allowed turns the flat 4MB ceiling into one
 * that scales with what was asked for.
 */
export const MAX_AUDIO_BYTES_PER_SECOND = 32 * 1024;
export const MIN_ANSWER_MS = 1_000;
/** Slack on top of the answer limit, for the recorder's final flush. */
export const DURATION_GRACE_MS = 3_000;
export const ALLOWED_AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav"] as const;

/** A question as the browser sees it. No expected points, no answer key. */
export type ClientQuestion = {
  id: string;
  position: number;
  kind: "behavioral" | "technical";
  prompt: string;
  topic: string;
  /** Sector label, technical questions only. */
  sectorLabel?: string;
  difficulty: "foundational" | "intermediate" | "advanced";
};

export type AnswerStatus = "pending" | "processing" | "complete" | "failed" | "skipped";

export type ScoreCategory =
  | "grammarClarity"
  | "pacePauses"
  | "fillers"
  | "structure"
  | "relevance"
  | "completeness"
  | "logic"
  | "concision";

export const SCORE_CATEGORY_LABELS: Record<ScoreCategory, string> = {
  grammarClarity: "Grammar & clarity",
  pacePauses: "Pace & pauses",
  fillers: "Filler words & repetition",
  structure: "Structure",
  relevance: "Relevance",
  completeness: "Completeness",
  logic: "Logic",
  concision: "Concision",
};

/** Delivery, measured from the transcript and its word timings - no model. */
export type DeliveryMetrics = {
  wordCount: number;
  durationSec: number;
  wordsPerMinute: number | null;
  /** Gaps of 1.5s or more between words. Null when the provider gave no word timings. */
  pauses: { count: number; longest: number; totalSec: number } | null;
  fillers: { total: number; perMinute: number | null; top: { word: string; count: number }[] };
  repeatedPhrases: { phrase: string; count: number }[];
  /** Probable stutters or disfluencies. ALWAYS an estimate - a transcript
   *  cannot hear a block or a prolongation, and providers tidy speech up. */
  disfluencyEstimate: { count: number; examples: string[] };
};

export type AnswerFeedback = {
  /** "full" = delivery + model content feedback; "delivery_only" = the model
   *  was unavailable, so only the measured delivery is reported. */
  level: "full" | "delivery_only";
  summary: string;
  strengths: string[];
  improvements: string[];
  grammarNotes: string[];
  /** How many of the server-only expected points the answer conveyed. A
   *  count, never the points themselves - what was missing is described in
   *  the grader's own words in `improvements`. */
  conceptCoverage?: { covered: number; total: number };
  factualErrors?: string[];
  /** Behavioral: which STAR parts were clearly present. */
  star?: { situation: boolean; task: boolean; action: boolean; result: boolean; reflection: boolean };
  scores: Partial<Record<ScoreCategory, number>>;
  overall: number | null;
  delivery: DeliveryMetrics;
};

export type ClientAnswer = {
  questionId: string;
  status: AnswerStatus;
  transcript: string | null;
  feedback: AnswerFeedback | null;
  /** A plain-language reason when status is failed. */
  error: string | null;
  /** A training recording of this answer is stored (training opt-in only). */
  retained: boolean;
  /** Recorded, but speech-to-text was not set up, so it was kept on the
   *  student's device for practice and never scored. Distinct from a
   *  question the student skipped. */
  practiceOnly: boolean;
};

/** One word or phrase for an answer's state, used everywhere it is shown. */
export function answerStatusLabel(a: Pick<ClientAnswer, "status" | "practiceOnly"> | undefined): string {
  if (!a) return "To come";
  switch (a.status) {
    case "complete":
      return "Answered";
    case "skipped":
      return a.practiceOnly ? "Recorded — not scored" : "Skipped";
    case "failed":
      return "Not scored";
    case "processing":
      return "Processing";
    default:
      return "To come";
  }
}

export type InterviewReport = {
  overall: number | null;
  categories: Partial<Record<ScoreCategory, number>>;
  answered: number;
  totalFillers: number;
  averageWpm: number | null;
  disfluencyEstimate: number;
  topStrengths: string[];
  topImprovements: string[];
  /** Answers graded on delivery only because content grading was unavailable. */
  deliveryOnlyCount: number;
};

export type ClientSession = {
  id: string;
  mode: InterviewMode;
  thinkSeconds: number;
  answerSeconds: number;
  status: "in_progress" | "complete";
  tailoredTo: string;
  questions: ClientQuestion[];
  answers: ClientAnswer[];
  report: InterviewReport | null;
  createdAt: string;
  /** This interview's own training decision (server-recorded). */
  training: { optedIn: boolean; decidedAt: string | null };
};

// ---------- consent ----------

/**
 * The version of the video interview's data terms. Separate from the site's
 * POLICY_VERSION on purpose: changing how interview recordings are handled
 * must re-ask about recordings without re-gating every account on the site,
 * and a training opt-in given under one version is not an opt-in to the next.
 * Bump it whenever what is kept, for how long, or for what changes.
 *
 * 2026-09-29: training kept the camera VIDEO with its audio (previously
 * audio only), in private object storage.
 * 2026-09-30: training consent is asked PER INTERVIEW, in a dialog at
 * "Start interview", instead of by an account-wide switch. A material change
 * to how consent is collected, so earlier consents are asked again.
 *
 * LEGAL REVIEW: the consent and retention wording below is a product draft,
 * written to be accurate to what the code does. It has not been reviewed by
 * counsel and must be before launch - in particular retention periods, the
 * training use, and any jurisdiction-specific (e.g. biometric) requirements.
 */
export const VIDEO_POLICY_VERSION = "2026-09-30";

/** Required to use the feature at all: processing the answer to give feedback. */
export const ANALYSIS_CONSENT_POINTS = [
  "The audio of each answer is sent to Offerly's server, turned into a transcript by our speech-to-text provider, and scored by our AI grader. The audio is not kept afterwards.",
  "Offerly keeps the transcript and feedback so you can see your report.",
  "Your camera video stays in this browser tab for playback and download. It is only uploaded if you choose to contribute your interviews - you're asked once, the first time you start one, and can change your answer in Profile > Connections.",
  "You can delete any interview, or all of them, at any time from this page.",
] as const;

/** The per-interview question, shown in the dialog at "Start interview". */
// Asked once, at the first Start; the answer stands for every interview after
// until the student changes it under "Training recordings" (consent.ts).
export const TRAINING_DIALOG_TITLE = "Contribute your interviews to improve Offerly?";
export const TRAINING_DIALOG_POINTS = [
  "If you say yes, Offerly keeps the video and voice recordings of your answers in this interview and the ones you do after it.",
  "They're stored privately and used to train and improve Offerly's interview-coaching AI.",
  "They're never shared with employers or made public.",
  "We only ask once. You can change your answer, or delete every recording you've contributed, at any time in Profile > Connections.",
  "Saying no doesn't change anything else - you get the same interview and the same feedback.",
] as const;
export const TRAINING_DIALOG_NO_STORAGE =
  "Recording storage isn't set up on this server right now, so no training recording can be kept from your interviews, whichever you choose.";
/** The two answers - equal weight, neither preselected. */
export const TRAINING_CHOICES = [
  { value: "yes", label: "Yes, contribute my interviews" },
  { value: "no", label: "No, don't share them" },
] as const;
export type TrainingChoice = (typeof TRAINING_CHOICES)[number]["value"];

// ---------- training recordings (video) ----------

/** The recorder's target rates (VideoInterview.tsx): ~1 Mbps video, 64 kbps audio. */
export const VIDEO_BITS_PER_SECOND = 1_000_000;
export const VIDEO_AUDIO_BITS_PER_SECOND = 64_000;
export const ALLOWED_VIDEO_TYPES = ["video/webm", "video/mp4"] as const;

/** The hard ceiling for one answer's training video: three minutes at the
 *  target rates is ~24MB; this allows the encoder half again on top. */
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024;

/**
 * The most a recording of this length can plausibly be: its duration (plus
 * two seconds) at 1.5x the target bitrate, plus 512KB of container, capped at
 * MAX_VIDEO_BYTES. A file far larger than its duration explains is refused.
 */
export function maxVideoBytesFor(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  const bitsPerSecond = (VIDEO_BITS_PER_SECOND + VIDEO_AUDIO_BITS_PER_SECOND) * 1.5;
  const bytes = ((durationMs / 1000 + 2) * bitsPerSecond) / 8 + 512 * 1024;
  return Math.min(MAX_VIDEO_BYTES, Math.floor(bytes));
}

/** What the server can do right now - booleans only, never configuration. */
export type CoachCapabilities = {
  transcription: boolean;
  trainingStorage: boolean;
};
