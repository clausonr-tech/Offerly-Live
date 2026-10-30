import type { AnswerFeedback, InterviewReport, ScoreCategory } from "./types";

/**
 * Request limits for the video coach, and the final report's arithmetic. Pure,
 * so both are tested without a database.
 *
 * The limits sit on top of the shared daily AI quota (lib/ai-runner), which
 * already caps grading. These cap what the quota does not see: speech-to-text
 * calls and uploads, which cost money and bandwidth even when grading is off.
 */
export const LIMITS = {
  /** Interviews started per student per rolling day. */
  sessionsPerDay: 12,
  /** Answer submissions (including retries) per student per ten minutes. */
  submissionsPerWindow: 15,
  submissionWindowMs: 10 * 60 * 1000,
  /** Tries at one answer before it is left as failed. */
  attemptsPerAnswer: 5,
  /** A submission still "processing" after this is presumed dead (the
   *  request crashed or timed out) and may be claimed again. */
  staleProcessingMs: 3 * 60 * 1000,
} as const;

export function sessionLimitMessage(startedInLastDay: number): string | null {
  return startedInLastDay >= LIMITS.sessionsPerDay
    ? `You've started ${LIMITS.sessionsPerDay} video interviews today. Take a break and come back tomorrow.`
    : null;
}

export function submissionLimitMessage(inWindow: number): string | null {
  return inWindow >= LIMITS.submissionsPerWindow
    ? "That's a lot of uploads in a few minutes. Wait a moment, then try again."
    : null;
}

const CATEGORIES: ScoreCategory[] = [
  "grammarClarity",
  "pacePauses",
  "fillers",
  "structure",
  "relevance",
  "completeness",
  "logic",
  "concision",
];

/** The interview's report, from the answers that were scored. */
export function buildReport(feedback: AnswerFeedback[]): InterviewReport {
  const categories: Partial<Record<ScoreCategory, number>> = {};
  for (const c of CATEGORIES) {
    const vals = feedback.map((f) => f.scores[c]).filter((v): v is number => typeof v === "number");
    if (vals.length) categories[c] = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
  }
  const overalls = feedback.map((f) => f.overall).filter((v): v is number => typeof v === "number");
  const wpms = feedback.map((f) => f.delivery.wordsPerMinute).filter((v): v is number => typeof v === "number");

  const firstOf = (pick: (f: AnswerFeedback) => string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    // One from each answer before a second from any, so the headline is not
    // three notes about the same question.
    for (let round = 0; round < 3 && out.length < 3; round++) {
      for (const f of feedback) {
        const s = pick(f)[round];
        if (s && !seen.has(s.toLowerCase()) && out.length < 3) {
          seen.add(s.toLowerCase());
          out.push(s);
        }
      }
    }
    return out;
  };

  return {
    overall: overalls.length ? Math.round(overalls.reduce((s, v) => s + v, 0) / overalls.length) : null,
    categories,
    answered: feedback.length,
    totalFillers: feedback.reduce((s, f) => s + f.delivery.fillers.total, 0),
    averageWpm: wpms.length ? Math.round(wpms.reduce((s, v) => s + v, 0) / wpms.length) : null,
    disfluencyEstimate: feedback.reduce((s, f) => s + f.delivery.disfluencyEstimate.count, 0),
    topStrengths: firstOf((f) => f.strengths),
    topImprovements: firstOf((f) => f.improvements),
    deliveryOnlyCount: feedback.filter((f) => f.level === "delivery_only").length,
  };
}
