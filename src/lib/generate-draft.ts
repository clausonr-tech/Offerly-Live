import "server-only";
import { runAiFeature } from "./ai-runner";
import { runDraftPipeline, type PipelineEvent, type PipelineResult } from "./draft-pipeline";
import type { DraftGap, DraftPromptInput, RawDraft } from "./draft-prompt";
import { getSubCallConfig } from "./model-registry";

/** The review pass's config, from its single source: lib/model-registry's `draftReview`. */
const DRAFT_REVIEW_CONFIG = getSubCallConfig("draftReview", "free");

export type { DraftKind, EmailTypeId } from "./draft-templates";
export type { DraftBrief, DraftGap } from "./draft-prompt";

// Drafts are built from the Offerly Email Drafts playbooks: each type has a
// format and a set of example emails, and a type is shown only its own
// examples. The examples set format, tone and length; the facts come only from
// the student and the recipient. The prompt lives in draft-prompt.ts and the
// draft-then-review flow in draft-pipeline.ts, so both can be built, tested and
// run without the database.

export async function generateEmailDraft(
  input: Omit<DraftPromptInput, "hasResumePdf"> & {
    userId: string;
    /** The student's resume, when it is a PDF the model can read. */
    resumePdf?: Buffer | null;
    /**
     * Report the draft as it is written, for the streaming composer
     * (lib/draft-stream). Absent on every other caller, and absent means the
     * pipeline runs exactly as it did before streaming existed.
     */
    onEvent?: (event: PipelineEvent) => void;
  },
): Promise<
  RawDraft & {
    gaps: DraftGap[];
    notesForStudent: string[];
    preReview: PipelineResult["preReview"];
    review: PipelineResult["review"];
    /** What the review cost, under the model that served it. Null when it never ran. */
    reviewUsage: PipelineResult["reviewUsage"];
  }
> {
  const { userId, onEvent, ...pipelineInput } = input;
  // The draft and its review run inside one runAiFeature, the way the resume
  // review's six calls do: one unit of the student's daily quota and one usage
  // row carrying what both calls actually cost. The draft call follows this
  // user's plan and falls back on capacity errors; the review is always Sonnet
  // and never fails the draft (see runDraftPipeline).
  const { result } = await runAiFeature({ feature: "draft", userId }, async (client, cfg) => {
    const result = await runDraftPipeline(client, pipelineInput, {
      draft: cfg,
      review: DRAFT_REVIEW_CONFIG,
      // The outreach page's own maxDuration. Every time gate inside the
      // pipeline is cut from it, which is what stops them contradicting each
      // other: the skip gate used to measure drafting against 80 s while the
      // retry gate measured drafting plus a whole review against 60 s, and the
      // retry was unreachable for any draft between ~50 s and 80 s.
      requestBudgetMs: 120_000,
      // Past 80 seconds of drafting there is no room left for the review, so it
      // is skipped. Kept explicit at the figure the measurements were taken at
      // rather than derived, so this change moves the retry window and nothing
      // else.
      reviewSkipAfterMs: 80_000,
      onEvent,
    });
    // The DRAFT's tokens, not both calls'. This row's `model` column is the
    // model the draft's fallback walk landed on, so recording the review's
    // Sonnet tokens here too made every column of it describe a different
    // call. The review's own cost comes back on `reviewUsage` and is on the
    // pipeline's log line; a durable row for it needs a `draftReview` value in
    // the ai_feature enum, which is a migration, not this file.
    return { usage: result.draftUsage, result };
  });
  return { ...result.draft, preReview: result.preReview, review: result.review, reviewUsage: result.reviewUsage };
}
