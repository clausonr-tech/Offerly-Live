import "server-only";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { runAiFeature } from "./ai-runner";
import { outputConfigFor } from "./model-registry";
import { parseWith } from "./fast-mode";

// Built per call rather than once at module load: a top-up run asks only for
// the firms still missing, so the cap has to move with the request. Headroom of
// 20%, because the model occasionally returns a near-duplicate or a slug that
// fails validation below, and clipping at exactly the target would turn every
// such case into a short list.
const pickSchemaFor = (max: number) =>
  z.object({
    picks: z
      .array(
        z.object({
          slug: z.string(),
          reason: z.string(),
        }),
      )
      .max(Math.ceil(max * 1.2)),
  });

export type FirmPick = { slug: string; reason: string };

export async function findTopFirms(input: {
  userId: string;
  /** How many firms to pick. A top-up run asks only for what is still missing. */
  pickCount: number;
  studentSchool?: string | null;
  /** Decides which recruiting cycle is open to them. */
  studentGradYear?: number | null;
  studentSponsorshipNeeded?: string | null;
  studentInterests?: string | null;
  studentMotivations?: string | null;
  studentWorkStyle?: string | null;
  studentNicheInterests?: string[] | null;
  studentTargetLocations?: string[] | null;
  studentRecruitingStage?: string | null;
  studentPriorExperience?: string[] | null;
  studentClubs?: string | null;
  studentProudExperience?: string | null;
  studentHometown?: string | null;
  /** Question keys the student explicitly marked "not sure yet". */
  studentUnsure?: string[] | null;
  /** The student's own answers to the background questions on their profile. */
  studentBackground?: { prompt: string; answer: string }[];
  candidateFirms: {
    slug: string;
    name: string;
    headquarters: string;
    description: string;
    categories: string[];
  }[];
}): Promise<FirmPick[]> {
  const studentFacts = [
    input.studentSchool && `School: ${input.studentSchool}`,
    // Grad year was collected from the first screen of onboarding and then
    // never reached this prompt, so a 2030 freshman and a 2027 senior were
    // ranked identically. Finance recruits ~18 months early, so the cycle a
    // student is actually in changes which firms are worth naming at all.
    input.studentGradYear &&
      `Graduating: ${input.studentGradYear} (so they are recruiting for the ` +
        // Junior summer, i.e. the summer before graduation - same rule as
        // targetProgramYear() in internship-postings, inlined rather than
        // imported so this module doesn't pull in the crawler and db client.
        `summer ${input.studentGradYear - 1} internship cycle)`,
    input.studentHometown && `Hometown: ${input.studentHometown}`,
    input.studentRecruitingStage && `Where they are in recruiting: ${input.studentRecruitingStage}`,
    input.studentInterests && `Interests: ${input.studentInterests}`,
    input.studentClubs && `Clubs / activities: ${input.studentClubs}`,
    input.studentPriorExperience?.length &&
      `Relevant experience so far: ${input.studentPriorExperience.join(", ")}`,
    input.studentMotivations && `Why finance / what they're looking for: ${input.studentMotivations}`,
    input.studentProudExperience && `Proudest accomplishment: ${input.studentProudExperience}`,
    input.studentWorkStyle && `Work style: ${input.studentWorkStyle}`,
    input.studentNicheInterests?.length && `Niche interests: ${input.studentNicheInterests.join(", ")}`,
    input.studentTargetLocations?.length && `Target locations: ${input.studentTargetLocations.join(", ")}`,
    input.studentSponsorshipNeeded === "Yes" &&
      `They WILL need US visa sponsorship. Some programs state that they do not ` +
        `sponsor - weigh that, and say so in the reason if it is a known constraint ` +
        `at a firm you pick.`,
    // Undecided is information, not a gap. Passing it explicitly stops the
    // model inventing a preference the student never expressed.
    input.studentUnsure?.length &&
      `The student explicitly said they are UNDECIDED on: ${input.studentUnsure.join(", ")}. ` +
        `Do not assume a preference on these. Favour firms that would give them broad exposure ` +
        `and a chance to find out, and say so in the reason.`,
    // The background answers from their profile. These are the student in their
    // own words rather than a dropdown selection, so they carry the specifics -
    // which team they led, what actually drew them to finance - that make a
    // reason concrete instead of boilerplate.
    input.studentBackground?.length &&
      `In the student's own words:\n` +
        input.studentBackground
          .map((b) => `  Q: ${b.prompt}\n  A: ${b.answer.slice(0, 800)}`)
          .join("\n"),
  ]
    .filter(Boolean)
    .join("\n");

  const firmList = input.candidateFirms
    .map((f) => `- ${f.slug} | ${f.name} | ${f.headquarters} | ${f.categories.join("/")} | ${f.description}`)
    .join("\n");

  const response = await runAiFeature(
    { feature: "firmMatch", userId: input.userId },
    (client, cfg) =>
      // parseWith: the paid tier's matcher runs fast mode (lib/fast-mode).
      parseWith(client, cfg)({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        output_config: outputConfigFor(cfg, {
          format: zodOutputFormat(pickSchemaFor(input.pickCount)),
        }),
        system:
          "You are a finance recruiting research assistant helping a college student identify which firms " +
          "from a candidate list are the best specific fit for them. You will be given the student's profile and a " +
          `list of candidate firms (already filtered to their preferred sectors). Pick the ${input.pickCount} firms ` +
          "from that list that are the strongest fit, given everything you know about the student - not just generic " +
          "prestige. " +
          "Spread the list across their preferred sectors and across firm sizes - a mix of bulge bracket, elite " +
          "boutique and middle market gives a student a realistic set to work rather than six names everyone targets. " +
          "On a list this long the spread is the whole point - it is a term's worth of recruiting, not a shortlist, " +
          "so it must run from reach firms through realistic targets down to genuinely attainable ones. Order matters - " +
          "put the strongest fits first, because the student sees the top of this list before they see the rest. " +
          "You MUST only pick firms from the given list, using the exact slug provided - never invent a firm or " +
          "use a slug that isn't in the list. For each pick, give a one-sentence, specific reason grounded in the " +
          "student's actual profile (not generic boilerplate like 'great firm with strong deal flow').",
        messages: [
          {
            role: "user",
            content: `Student profile:\n${studentFacts || "(no additional profile details given)"}\n\nCandidate firms (slug | name | HQ | categories | description):\n${firmList}\n\nPick the ${input.pickCount} best-fit firms, strongest fit first.`,
          },
        ],
      }),
  );

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to respond. Try again.");
  }
  if (!response.parsed_output) {
    throw new Error("Couldn't generate recommendations. Try again.");
  }

  // Defensive: drop anything that isn't actually in the candidate list, in
  // case the model still returns a slug that doesn't exist.
  const validSlugs = new Set(input.candidateFirms.map((f) => f.slug));
  return response.parsed_output.picks.filter((p) => validSlugs.has(p.slug));
}
