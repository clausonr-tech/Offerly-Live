import "server-only";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { runAiFeature } from "./ai-runner";
import { outputConfigFor } from "./model-registry";
import { parseWith } from "./fast-mode";
import type { ResumeReview } from "./resume-review";

// Applies a review's findings and returns the whole resume rewritten.
//
// The output is STRUCTURED, not a block of text. Two reasons: the student edits
// it field by field in the app rather than retyping a document, and both
// exporters (docx and pdf) need to know which line is a heading, which is a
// role and which is a bullet in order to lay the page out. A single string
// would force both of those to re-parse prose the model had already structured.
//
// Education fits the same entry shape as Experience - org is the school, role
// the degree, and the bullets carry GPA, coursework and honours - so one shape
// covers every section a finance resume has.

const entrySchema = z.object({
  org: z.string(),
  role: z.string(),
  location: z.string(),
  dates: z.string(),
  bullets: z.array(z.string()),
});

// What the original page looks like, read off the PDF before anything is
// rewritten. Without this the exporters impose a house style and the student
// gets back a document that is theirs in words only.
const formatSchema = z.object({
  /** The font as it appears, e.g. "Times New Roman". Best guess is fine. */
  fontFamily: z.string(),
  /** Drives the PDF, which has only a serif and a sans face available. */
  serif: z.boolean(),
  bodySizePt: z.number(),
  nameSizePt: z.number(),
  headingSizePt: z.number(),
  /** Page margin in points (72pt = 1 inch). */
  marginPt: z.number(),
  nameAlign: z.enum(["left", "center"]),
  headingUppercase: z.boolean(),
  /** A horizontal rule under each section heading. */
  headingRule: z.boolean(),
  /** Dates in a right-hand column rather than trailing the title. */
  datesRightAligned: z.boolean(),
  italicRole: z.boolean(),
  italicDates: z.boolean(),
  bulletChar: z.string(),
  /** Line height as a multiple of the body size. */
  lineSpacing: z.number(),
  /** Any formatting that had to change because a requested fix demanded it. */
  changedFromOriginal: z.array(z.string()),
});

const revisedSchema = z.object({
  format: formatSchema,
  name: z.string(),
  /** One line: email, phone, city, LinkedIn - whatever the original carried. */
  contact: z.string(),
  sections: z.array(
    z.object({
      heading: z.string(),
      entries: z.array(entrySchema),
    }),
  ),
  /** What changed and what the student still has to supply. */
  changeLog: z.array(z.string()),
});

type RevisedResumeEntry = z.infer<typeof entrySchema>;
export type ResumeFormat = z.infer<typeof formatSchema>;
export type RevisedResume = {
  /** Absent on drafts made before formatting was captured. */
  format?: ResumeFormat;
  name: string;
  contact: string;
  sections: { heading: string; entries: RevisedResumeEntry[] }[];
  changeLog: string[];
};

export async function buildRevisedResume(input: {
  userId: string;
  pdf: Buffer;
  review: Pick<ResumeReview, "improvements" | "rewrites" | "summary">;
  /** Figures the student supplied, one entry per change they answered. */
  answers?: { line: string; question: string; answer: string }[];
}): Promise<RevisedResume> {
  const findings = input.review.improvements
    .map((i) => `- [${i.severity}] ${i.dimension}: ${i.title} - ${i.detail}`)
    .join("\n");

  const rewrites = input.review.rewrites
    .map((r) => `- (${r.kind}) BEFORE: ${r.before}\n  AFTER: ${r.after}`)
    .join("\n");

  const supplied = (input.answers ?? [])
    .map((a) =>
      a.question
        ? `- In the line "${a.line}", the gap "${a.question}" is: ${a.answer}`
        : `- For "${a.line}", the student adds: ${a.answer}`,
    )
    .join("\n");

  const response = await runAiFeature(
    { feature: "resumeRewrite", userId: input.userId },
    (client, cfg) =>
      // parseWith: the paid tier's rewrite runs fast mode (lib/fast-mode).
      parseWith(client, cfg)({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        output_config: outputConfigFor(cfg, { format: zodOutputFormat(revisedSchema) }),
        system:
          "You rewrite an undergraduate's finance resume by applying a review that has already been " +
          "done. The attached PDF is their current resume; the findings below are what to change.\n\n" +
          "Hard rules - these are what keep the result honest:\n" +
          "- Every fact must come from the original resume. Never invent an employer, a title, a date, " +
          "a course, a club or an achievement.\n" +
          "- Never invent a number. Where a bullet would be stronger with a figure the original does not " +
          "contain, write a bracketed placeholder naming exactly what to find - for example " +
          "'[add figure: how many companies in the screen?]'. The student fills these in themselves.\n" +
          "- Keep every real role and every real section. Reordering, retitling and rewording is the " +
          "job; deleting the student's actual experience is not.\n" +
          "- Apply ONLY the changes listed below. The student chose these deliberately and left the " +
          "rest out. Anything not named stays as it is on the original, even where you would have " +
          "written it differently.\n\n" +
          "Formatting - do this FIRST, before rewriting a single line:\n" +
          "- Read the attached PDF's formatting and report it in `format`: the font, the body/name/" +
          "heading sizes in points, the page margin, whether the name is centred, whether section " +
          "headings are uppercase and ruled, whether dates sit in a right-hand column, whether roles " +
          "or dates are italicised, the bullet character, and the line spacing.\n" +
          "- Report what the ORIGINAL actually looks like. This is measurement, not preference - do " +
          "not report the formatting you would have chosen.\n" +
          "- The rewritten resume keeps that formatting. Change it ONLY where a requested fix cannot " +
          "be done otherwise - fitting two pages onto one, or making date formats consistent - and " +
          "list every such change in `format.changedFromOriginal`. If no requested fix concerns " +
          "formatting, `changedFromOriginal` is empty and every value matches the original.\n\n" +
          "How to write it:\n" +
          "- Bullets read Action Verb + Task + Measurable Result, past tense for finished roles and " +
          "present for a current one.\n" +
          "- Education comes first for an undergraduate, then Experience in reverse-chronological " +
          "order, then Leadership/Activities if present, then Skills & Interests.\n" +
          "- A section with no entries should be omitted rather than left empty.\n" +
          "- For a Skills or Interests section, use one entry with empty org/role/location/dates and " +
          "put each line in bullets.\n" +
          "- Aim for what fits on one page: roughly 3-5 bullets per substantive role, one or two lines " +
          "each.\n\n" +
          "changeLog: one short line per meaningful change, written to the student. Call out every " +
          "bracketed placeholder you left, so they know what is still outstanding.\n\n" +
          "Review summary:\n" +
          input.review.summary +
          "\n\nFindings to apply:\n" +
          (findings || "(none)") +
          "\n\nRewrites already drafted during the review - reuse these where they fit:\n" +
          (rewrites || "(none)") +
          (supplied
            ? "\n\nThe student supplied these figures for the changes named. Use them verbatim in " +
              "the rewritten lines - do not round them, restate them as ranges, or leave the " +
              "bracketed placeholder in place once you have the number:\n" + supplied
            : ""),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: input.pdf.toString("base64"),
                },
              },
              {
                type: "text",
                text:
                  "Rewrite this resume applying the listed changes and only those. " +
                  "Return the complete document, including the parts you left untouched.",
              },
            ],
          },
        ],
      }),
  );

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("The rewrite came back empty. Try again.");
  return parsed as RevisedResume;
}
