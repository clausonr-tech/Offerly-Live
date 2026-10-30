import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { runAiFeature } from "./ai-runner";
import { outputConfigFor, thinkingFor, type ModelConfig } from "./model-registry";
import { parseWith } from "./fast-mode";

// Resume review for a finance-recruiting student, run as five critics.
//
// Four decisions shape this file.
//
// 1. The PDF is sent as a document, NOT as extracted text. Half of what a
//    student needs to hear is about layout - is it one page, are the margins
//    sane, does the eye land on the right things in a six-second skim. Text
//    extraction destroys exactly that signal, and would also mean adding a PDF
//    parser the project does not currently have.
//
// 2. The model judges; the rubric below scores. Same split as lib/grading.ts
//    and for the same reasons: a model asked for a number will drift between
//    runs and between resumes, whereas counting issues by severity is
//    arithmetic. It also means the weighting can be retuned without touching
//    the prompt.
//
// 3. Five critics, five calls, plus a sixth that writes the summary. This used
//    to be one call for all five, to avoid paying for the PDF five times. That
//    saved tokens and cost depth: one reasoning pass was being split across
//    five critics, forty possible issues and two sets of rewrites, so each
//    criterion got about a fifth of the model's attention and returned the
//    median thing anyone says about resumes.
//
//    The cost objection is answered by caching rather than by batching. The
//    shared instructions and the PDF are a byte-identical prefix on all five
//    requests, so the first critic writes that prefix to cache and the rest
//    read it at a fraction of the price. The first call is therefore made
//    alone - firing all five at once would race, all miss, and pay full price
//    five times.
//
//    All six calls run inside ONE runAiFeature, so a review is still one unit
//    of the student's daily quota and one row of aiUsage carrying the summed
//    tokens. Splitting them would have made a single review cost six of the
//    twenty-five actions a free user gets in a day.
//
// 4. Two of the critics rewrite rather than grade. Their suggestions come back
//    as before/after pairs the student can copy. Where a rewrite needs a figure
//    the resume does not contain, the model leaves a bracketed placeholder
//    naming what to find - it never invents the number.

const DIMENSIONS = [
  {
    id: "honest",
    label: "First impression",
    weight: 30,
    brief:
      "You are a senior hiring manager screening the pile for an investment banking, private equity or " +
      "adjacent finance role. Say plainly what is weak, what is missing, and what would make you reject " +
      "this resume in the six seconds you actually give it. This is also where the format basics are " +
      "judged: one page; Education first with school, degree, graduation date and GPA; Experience in " +
      "reverse-chronological order with no unexplained gaps; consistent margins, alignment and bullet " +
      "indentation; body text no smaller than 10pt; and the banking conventions - no photo, no objective " +
      "statement, no personal-details block, no references line.",
  },
  {
    id: "bullets",
    label: "Experience & impact",
    weight: 25,
    brief:
      "Every bullet should read as Action Verb + Task + Measurable Result. Flag bullets that list duties " +
      "instead of outcomes, that open with a weak verb ('assisted with', 'responsible for', 'helped'), or " +
      "that end with no number, no decision and no consequence. Rewrite the weak ones.",
  },
  {
    id: "ats",
    label: "Keywords & scanning",
    weight: 15,
    brief:
      "Whether the resume survives automated screening. Check that the file parses cleanly - no tables, " +
      "text boxes, multi-column layouts, headers/footers carrying real content, or graphics standing in " +
      "for text - and that section headings use standard names a parser recognises. When a target job " +
      "description is supplied, also name the specific keywords and skills it asks for that this resume " +
      "does not contain, and say which existing bullets should be reworded to carry them.",
  },
  {
    id: "tone",
    label: "Industry fit",
    weight: 15,
    brief:
      "Whether this reads like someone who belongs in finance or like a generic applicant. Judge the " +
      "summary and skills sections against the language and values of the banks and funds the student is " +
      "targeting: precise, understated, outcome-led, no inflated adjectives. Rewrite the summary and the " +
      "skills section so they sound native to the industry.",
  },
  {
    id: "polish",
    label: "Proofing & consistency",
    weight: 15,
    brief:
      "The last pass. Consistency of verb tense (past for finished roles, present for the current one), " +
      "consistent date formatting, no unexplained acronyms, and no clichés or filler - 'team player', " +
      "'hardworking', 'detail-oriented', 'passionate about finance', anything that could sit on anyone " +
      "else's resume unchanged.",
  },
] as const;

type DimensionId = (typeof DIMENSIONS)[number]["id"];

// How much of a dimension one issue costs. Two majors take most of a dimension
// away; a handful of minors dents it without wiping it out.
const PENALTY = { major: 0.3, minor: 0.1 } as const;

// The most a dimension can lose. A resume that reached the upload box is a real
// draft by a real student - there is always something standing, and a hard zero
// reads as "this is worthless" rather than "here is the work to do". Holding a
// quarter of every dimension keeps the floor at 25/100: unmistakably "start
// here", still not a wipeout. Ordering between resumes is unaffected, since the
// cap only binds once a dimension is already badly down.
const MAX_PENALTY = 0.75;

// The most issues one critic may raise. Five critics at four apiece is twenty,
// where the single-call version allowed forty - but the cap now binds per
// criterion rather than across the whole review, so a critic choosing its four
// is choosing from its own full reasoning pass. The old budget let the model
// spend its allowance on whichever criterion it happened to think about first,
// and rewarded finding forty things over understanding four.
const MAX_ISSUES_PER_CRITIC = 4;

// Which critics may return rewrites, and of what kind. Kept beside the cap
// rather than inside DIMENSIONS so the exported rubric shape stays as it was.
const REWRITE_KINDS: Partial<Record<DimensionId, readonly ResumeRewrite["kind"][]>> = {
  bullets: ["bullet"],
  tone: ["summary", "skills"],
};

const issueSchema = z.object({
  severity: z.enum(["major", "minor"]),
  title: z.string(),
  detail: z.string(),
});

const rewriteSchema = z.object({
  kind: z.enum(["bullet", "summary", "skills"]),
  severity: z.enum(["major", "minor"]),
  before: z.string(),
  after: z.string(),
  note: z.string(),
});

// One critic's verdict on one criterion. No `id`: the caller knows which critic
// it asked, so asking the model to repeat it back is a field that can only ever
// be wrong.
// `document_kind` is on every critic's schema, not only the first one's, so the
// five requests stay identical in everything but the criterion: a different
// output format per critic could cost the cached prefix they share.
export const DOCUMENT_KINDS = ["resume", "cover_letter", "email", "transcript", "other"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

const criticOutputSchema = z.object({
  /** What the uploaded file is. Anything but "resume" stops the review. */
  document_kind: z.enum(DOCUMENT_KINDS),
  notes: z.string(),
  /** What is already working in THIS criterion. The synthesis pass pools these. */
  strengths: z.array(z.string()),
  issues: z.array(issueSchema),
  rewrites: z.array(rewriteSchema),
});

// The sixth call. It never sees the PDF - it reads what the five critics found
// and writes the paragraph the student opens on, which is a judgement about the
// findings rather than about the page.
const synthesisOutputSchema = z.object({
  /** Two or three sentences a student would actually act on. No praise padding. */
  summary: z.string(),
  strengths: z.array(z.string()),
});

export type ResumeIssue = { severity: "major" | "minor"; title: string; detail: string };

export type ResumeRewrite = {
  kind: "bullet" | "summary" | "skills";
  /** Same scale as an issue: rewrites are filed into the same two lists, so a
   *  rewrite that would cost an interview sits with the other high-impact work
   *  rather than in a separate pile the student reads afterwards. */
  severity: "major" | "minor";
  before: string;
  after: string;
  /** Why it changed, and which figure the student still has to supply. */
  note: string;
};

export type ResumeDimensionResult = {
  id: DimensionId;
  label: string;
  score: number;
  max: number;
  notes: string;
  issues: ResumeIssue[];
};

export type ResumeReview = {
  score: number;
  summary: string;
  strengths: string[];
  dimensions: ResumeDimensionResult[];
  /** Every issue across dimensions, worst first - the actual to-do list. */
  improvements: (ResumeIssue & { dimension: string })[];
  rewrites: ResumeRewrite[];
};

function scoreDimension(weight: number, issues: ResumeIssue[]): number {
  const penalty = issues.reduce((sum, i) => sum + PENALTY[i.severity], 0);
  return Math.round(weight * (1 - Math.min(MAX_PENALTY, penalty)));
}

/**
 * Recomputes stored marks with the current rubric.
 *
 * The score is derived from the issues, and both are stored, so a review
 * written under an older penalty curve can be re-scored on read instead of
 * being frozen at whatever the rubric said the day it ran. That keeps every
 * review the student can see consistent with the weighting shown beside it.
 */
export function rescoreReview(dimensions: ResumeDimensionResult[]): {
  dimensions: ResumeDimensionResult[];
  score: number;
  improvements: (ResumeIssue & { dimension: string })[];
} {
  const next = dimensions.map((d) => {
    // Label and weight come from the rubric rather than the stored row, so
    // renaming a criterion reaches reviews written under the old name instead
    // of leaving the student with two vocabularies for the same thing.
    const canonical = DIMENSIONS.find((x) => x.id === d.id);
    const max = canonical?.weight ?? d.max;
    return {
      ...d,
      label: canonical?.label ?? d.label,
      max,
      score: scoreDimension(max, d.issues ?? []),
    };
  });

  const improvements = next
    .flatMap((d) => (d.issues ?? []).map((i) => ({ ...i, dimension: d.label })))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "major" ? -1 : 1));

  return { dimensions: next, score: next.reduce((sum, d) => sum + d.score, 0), improvements };
}

/** What the student is told the file looked like, by kind. */
const KIND_WORDS: Record<Exclude<DocumentKind, "resume">, string> = {
  cover_letter: "a cover letter",
  email: "an email",
  transcript: "a transcript",
  other: "something other than a resume",
};

/**
 * The upload is not a resume - an email, a cover letter, a transcript. No
 * feedback is given on it: five critics grading an email as a resume (it had
 * "no Education section") is advice about the wrong document (5 October 2026).
 */
export class NotAResumeError extends Error {
  constructor(readonly kind: Exclude<DocumentKind, "resume">) {
    super(
      `It reads like ${KIND_WORDS[kind]}, so there's no feedback to give on it. ` +
        "Upload your resume as a PDF and try again.",
    );
    this.name = "NotAResumeError";
  }
}

/**
 * Whether the first critic's answer stops the review. Only a clear "not a
 * resume" does: no answer at all (a failed parse) carries on as before, since
 * that is a problem with the call, not with the file.
 */
export function notAResume(kind: DocumentKind | null | undefined): Exclude<DocumentKind, "resume"> | null {
  return kind && kind !== "resume" ? kind : null;
}

export class UnsupportedResumeFormatError extends Error {
  constructor() {
    super("Resume review needs a PDF. Export your resume as a PDF and upload that.");
    this.name = "UnsupportedResumeFormatError";
  }
}

/**
 * Reviews a resume PDF and returns a scored, actionable critique.
 *
 * `pdf` is the raw file bytes. Only PDF is accepted: Word documents cannot be
 * passed to the model as a document block, and converting them would lose the
 * layout this review is largely about.
 *
 * `jobDescription` is optional. Supplied, it turns the ATS critic's keyword
 * check into a real comparison against that posting; omitted, that critic falls
 * back to judging machine-readability on its own.
 */
/**
 * The six model calls - five critics and the synthesis - with no quota, no
 * database and no user attached.
 *
 * Split out of reviewResume on 13 October 2026 so a rig can run it. The draft
 * pipeline learned this the hard way: a config no script can reach does not
 * get measured, and this is the most expensive configuration in the product -
 * six calls, each at high or xhigh effort with adaptive thinking and a
 * 6,000-token ceiling. See scripts/resume-review-live-eval.ts.
 *
 * reviewResume below is unchanged in behaviour: it still owns the filename
 * check, the quota, the usage row and the error translation.
 */
export async function runResumeReviewCalls(
  client: Anthropic,
  cfg: ModelConfig,
  input: { pdf: Buffer; jobDescription?: string | null },
) {
  const jd = input.jobDescription?.trim();
    // Everything stable goes here and nowhere else. This string plus the PDF
    // below is the cached prefix, so a single differing byte between critics
    // costs the cache and with it the reason five calls are affordable. The
    // criterion itself is deliberately NOT in here - it is the one thing that
    // varies, so it goes last, after the document.
    const system =
      "You review resumes for undergraduates recruiting for investment banking, private equity and " +
      "adjacent finance roles. You know exactly what a screener looks for, and you are coaching this " +
      "student through their next draft rather than delivering a verdict on this one.\n\n" +
      "First, say what the document is, in `document_kind`. It is `resume` if it is a resume or CV of " +
      "any quality - a rough first draft, a resume with no work experience yet, one written for another " +
      "field, or a resume with a cover letter attached all count. Use another kind only when the " +
      "document is plainly not a resume at all: `cover_letter` for a letter on its own, `email` for an " +
      "email or message, `transcript` for a grade transcript, `other` for anything else (an essay, a " +
      "proposal, a form, a blank page). When in doubt, it is a resume. If it is not a resume, stop " +
      "there: return empty `notes`, `strengths`, `issues` and `rewrites`, and review nothing.\n\n" +
      "You are acting as ONE critic on a panel of five. Judge only the criterion you are given. " +
      "Another critic is already covering everything else, so a problem outside your brief is not " +
      "yours to raise - say nothing about it rather than duplicating their finding.\n\n" +
      "Tone - this matters as much as the substance:\n" +
      "- Be specific and honest. Do not soften a real problem into vagueness, and do not pad with praise. " +
      "A student who is told everything is fine learns nothing.\n" +
      "- Frame every finding as the change to make, not as a judgement on the student. " +
      "'Move your GPA up next to the degree' - not 'you failed to include a GPA'.\n" +
      "- Never write an overall verdict on the student's prospects. No 'this would be rejected', " +
      "'does not pass the screen', 'not competitive'. The issues say what to fix; the reader draws " +
      "their own conclusion.\n\n" +
      "Rules:\n" +
      `- Return AT MOST ${MAX_ISSUES_PER_CRITIC} issues. This is a ceiling, not a target. Fewer findings ` +
      "that you have actually thought through beat a longer list of things that are merely true. If the " +
      "resume is genuinely strong on your criterion, return none - do not manufacture criticism to seem " +
      "thorough.\n" +
      "- `title` is at most 6 words: the student is scanning a list.\n" +
      "- `detail` is at most 45 words, and it is where the expertise has to show. Name the exact line, " +
      "say what a screener reads it as, and say what to do instead. 'Weak bullet' is useless. 'Deloitte " +
      "bullet opens \"assisted with\" and ends with no outcome - a screener reads that as observing, not " +
      "doing; lead with the verb for the work you actually owned and close on what changed' is the job.\n" +
      "- Mark an issue major only if it would plausibly cost an interview. Everything else is minor.\n" +
      "- Judge layout and density from how the page actually looks, not just its words.\n" +
      "- `strengths` names what is already working in YOUR criterion only, in at most two entries. " +
      "Return an empty list rather than reaching for something.\n\n" +
      "Rewrites:\n" +
      "- Return rewrites only if your brief says you may. Otherwise return an empty list.\n" +
      "- `before` quotes the line verbatim from the resume.\n" +
      "- Never invent an achievement, a metric, or work the student did not do. Where a rewrite needs " +
      "a number the resume does not give, write a bracketed placeholder naming exactly what to find - " +
      "for example '[add figure: how many companies in the screen?]' - and use `note` to say what the " +
      "student should dig up and why it matters.\n" +
      "- `note` is at most 12 words. It says what to change, nothing else. Do not repeat the " +
      "rewritten line back, and do not explain why at length.\n" +
      "- `severity` uses the same test as an issue: major only if leaving the line as it stands " +
      "would plausibly cost an interview, minor otherwise.\n\n" +
      (jd
        ? "A target job description is supplied below. It is relevant ONLY to the ats criterion; every " +
          "other critic should ignore it.\n\n<job_description>\n" +
          jd +
          "\n</job_description>"
        : "No job description was supplied. The ats critic judges machine-readability and standard " +
          "section naming only, and must not speculate about a specific posting's keywords.");

    // The PDF is the bulk of every request and identical in all five, so it
    // carries the cache breakpoint. Everything before it - the system prompt
    // above - is cached with it.
    const document = {
      type: "document" as const,
      source: {
        type: "base64" as const,
        media_type: "application/pdf" as const,
        data: input.pdf.toString("base64"),
      },
      cache_control: { type: "ephemeral" as const },
    };

    const runCritic = (d: (typeof DIMENSIONS)[number]) => {
      const kinds = REWRITE_KINDS[d.id];
      // parseWith: the paid tier's critics run fast mode (lib/fast-mode).
      return parseWith(client, cfg)({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        output_config: outputConfigFor(cfg, { format: zodOutputFormat(criticOutputSchema) }),
        ...thinkingFor(cfg),
        system,
        messages: [
          {
            role: "user",
            content: [
              document,
              {
                type: "text" as const,
                text:
                  `You are the ${d.id} critic (${d.label}).\n\n${d.brief}\n\n` +
                  (kinds
                    ? `You may return rewrites of kind: ${kinds.join(", ")}.`
                    : "You return no rewrites - `rewrites` must be an empty list.") +
                  "\n\nReview this resume against that criterion alone and report what to fix.",
              },
            ],
          },
        ],
      });
    };

    // Sequential, then parallel. The first call writes the shared prefix to
    // cache; firing all five together would race and every one would miss,
    // paying full price for the PDF five times over. One extra round trip is
    // a good price for four cache hits on the largest input in the product.
    const [firstDimension, ...restDimensions] = DIMENSIONS;
    const firstResponse = await runCritic(firstDimension);

    // The first critic also says what the file is. Not a resume, and the
    // review ends here - one call spent, not six, and no feedback on the
    // wrong document. Returned rather than thrown: runAiFeature records a
    // call's usage only when it returns, so a throw in here would leave the
    // tokens already spent unrecorded. The caller throws NotAResumeError.
    const rejected = notAResume(firstResponse.parsed_output?.document_kind);
    if (rejected) {
      return { usage: firstResponse.usage, review: null, rejected };
    }

    const restResponses = await Promise.all(restDimensions.map(runCritic));
    const criticResponses = [firstResponse, ...restResponses];

    const dimensions: ResumeDimensionResult[] = DIMENSIONS.map((d, i) => {
      const parsed = criticResponses[i].parsed_output;
      const issues = (parsed?.issues ?? []).slice(0, MAX_ISSUES_PER_CRITIC) as ResumeIssue[];
      return {
        id: d.id,
        label: d.label,
        max: d.weight,
        score: scoreDimension(d.weight, issues),
        // A critic that came back empty is reported as unassessed rather than
        // silently scored full marks.
        notes: parsed?.notes ?? "Not assessed.",
        issues,
      };
    });

    // Rewrites are only honoured from the critics allowed to make them, so a
    // critic that ignores its brief cannot inject a rewrite into the pile.
    const rewrites: ResumeRewrite[] = DIMENSIONS.flatMap((d, i) => {
      const kinds = REWRITE_KINDS[d.id];
      if (!kinds) return [];
      return ((criticResponses[i].parsed_output?.rewrites ?? []) as ResumeRewrite[]).filter((r) =>
        kinds.includes(r.kind),
      );
    });

    const findings = DIMENSIONS.map((d, i) => {
      const parsed = criticResponses[i].parsed_output;
      const issues = (parsed?.issues ?? [])
        .map((issue) => `  - [${issue.severity}] ${issue.title}: ${issue.detail}`)
        .join("\n");
      const strengths = (parsed?.strengths ?? []).map((s) => `  + ${s}`).join("\n");
      return `${d.label}\n${strengths || "  (no strengths named)"}\n${issues || "  (no issues)"}`;
    }).join("\n\n");

    const synthesis = await parseWith(client, cfg)({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      output_config: outputConfigFor(cfg, { format: zodOutputFormat(synthesisOutputSchema) }),
      ...thinkingFor(cfg),
      system:
        "Five critics have each reviewed one criterion of the same student's resume. Write the opening " +
        "the student reads first.\n\n" +
        "- `summary` is two or three sentences. Open with what is genuinely working, then name the one " +
        "or two changes that would move this resume most. Write it to the student, because they are the " +
        "one reading it.\n" +
        "- Never write a verdict on their prospects. No 'this would be rejected', 'not competitive'.\n" +
        "- `strengths` is at most four entries, pooled and de-duplicated from what the critics named. " +
        "Do not invent a strength no critic found, and do not pad the list to reach four.\n" +
        "- Add no new criticism. You are summarising these findings, not reviewing the resume yourself.",
      messages: [
        {
          role: "user",
          content: `Findings from the five critics:\n\n${findings}`,
        },
      ],
    });

    const improvements = dimensions
      .flatMap((d) => d.issues.map((i) => ({ ...i, dimension: d.label })))
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "major" ? -1 : 1));

    // One aiUsage row for the whole review, carrying what all six calls
    // actually cost. Reporting only one call's tokens would make the feature
    // look a sixth as expensive as it is, which is exactly the number model
    // choice gets tuned against later.
    const usage = [...criticResponses, synthesis].reduce(
      (sum, r) => ({
        input_tokens: sum.input_tokens + (r.usage?.input_tokens ?? 0),
        output_tokens: sum.output_tokens + (r.usage?.output_tokens ?? 0),
      }),
      { input_tokens: 0, output_tokens: 0 },
    );

    return {
      usage,
      rejected: null,
      review: {
        score: dimensions.reduce((sum, d) => sum + d.score, 0),
        summary: synthesis.parsed_output?.summary ?? "",
        strengths: synthesis.parsed_output?.strengths ?? [],
        dimensions,
        improvements,
        rewrites,
      } satisfies ResumeReview,
    };
}

export async function reviewResume(input: {
  userId: string;
  filename: string;
  pdf: Buffer;
  jobDescription?: string | null;
}): Promise<ResumeReview> {
  if (!input.filename.toLowerCase().endsWith(".pdf")) throw new UnsupportedResumeFormatError();

  const { review, rejected } = await runAiFeature(
    { feature: "resumeReview", userId: input.userId },
    (client, cfg) => runResumeReviewCalls(client, cfg, input),
  );

  if (rejected) throw new NotAResumeError(rejected);
  if (!review?.summary) throw new Error("Resume review came back empty. Try again.");
  return review;
}
