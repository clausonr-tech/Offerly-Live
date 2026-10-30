// INPUT-2 probe 4: the "Same school" literal-string coupling and near-misses.
import { computeRelevanceScore } from "../../../src/lib/relevance";
import { buildDraftPrompt, type DraftPromptInput } from "../../../src/lib/draft-prompt";
import { fullInput } from "./fields";

const user = (over: Partial<Parameters<typeof computeRelevanceScore>[0]> = {}) => ({
  school: "Duke University", hometown: null, interests: null, targetGroup: null, clubsAndActivities: null, ...over,
});
const contact = (school: string | null) => ({ school, background: null, notes: null });

const CASES: [string, string | null, string | null][] = [
  ["exact match", "Duke University", "Duke University"],
  ["Duke University vs Duke", "Duke University", "Duke"],
  ["Duke vs Duke University", "Duke", "Duke University"],
  ["Penn vs University of Pennsylvania", "Penn", "University of Pennsylvania"],
  ["UPenn vs Wharton", "UPenn", "Wharton"],
  ["Penn vs Penn State (lookalike)", "Penn", "Penn State"],
  ["Michigan vs Michigan State (lookalike)", "Michigan", "Michigan State"],
  ["U of Miami vs Miami University (lookalike)", "University of Miami", "Miami University"],
  ["UW vs University of Washington (ambiguous nick)", "UW", "University of Washington"],
  ["Duke w/ trailing space", "Duke University", " duke "],
  ["student has NO school", null, "Duke University"],
  ["contact has NO school", "Duke University", null],
  ["unlisted school, same spelling", "Lehigh University", "Lehigh University"],
  ["unlisted school, nickname", "Lehigh University", "Lehigh"],
  ["unlisted, abbreviation", "Lehigh University", "LU"],
];

console.log("case\treasons\tscore\talumniSchool set?\tgate fires?");
for (const [name, us, cs] of CASES) {
  const r = computeRelevanceScore(user({ school: us }), contact(cs));
  const gate = r.reasons.includes("Same school");
  console.log(`${name}\t[${r.reasons.join(" | ")}]\t${r.score}\t${gate ? `"${us}"` : "null"}\t${gate ? "YES" : "no"}`);
}

console.log("\n--- literal-string coupling ---");
const all = computeRelevanceScore(
  { school: "Duke University", hometown: "Atlanta", interests: "sailing", targetGroup: null, clubsAndActivities: "Investment Club" },
  { school: "Duke", background: "grew up in Atlanta, ran the Investment Club, sails", notes: null },
);
console.log("every reason computeRelevanceScore can emit for one contact:", JSON.stringify(all.reasons));
console.log('exact literal the gate tests for is "Same school":', all.reasons.includes("Same school"));

console.log("\n--- what the prompt says when the gate fails (cold_email = the alum type) ---");
for (const alum of [null, "Duke University"]) {
  const { userText } = buildDraftPrompt({
    ...fullInput("cold_email"),
    alumniSchool: alum,
    detectedOverlaps: alum ? ["Same school"] : [],
  } as DraftPromptInput);
  const line = userText.split("\n").find((l) => l.includes("alumni database") || l.includes("isn't confirmed as the student's"));
  console.log(`alumniSchool=${JSON.stringify(alum)} -> ${line}`);
}

console.log("\n--- the student-facing note, reproduced from the committed studentNotes ctx ---");
for (const gate of [true, false]) {
  const alumTypeWithoutSharedSchool = true /* type cold_email */ && !gate;
  console.log(`overlaps.includes("Same school")=${gate} -> note pushed: ${alumTypeWithoutSharedSchool}`);
}
