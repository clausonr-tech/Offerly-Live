// Can every multiple-choice round be served without repeating itself?
//
//   npx tsx --conditions=react-server scripts/check-choices.ts
//
// A round is ten questions at one difficulty. For a whole sector, that sector
// has to hold ten questions with options at every difficulty, or a round
// repeats a question the student has just seen - and a round with nothing left
// falls through to a generated written question, a model call in the format
// that is meant to cost nothing. That is a failure.
//
// A specialty is allowed to be thinner: most advanced questions are judgement
// calls with no single right answer, so few carry options. A specialty round
// draws its own questions first and tops up from its sector (see questionPools
// in lib/technical-question-bank), so what matters is that the specialty plus
// its sector reach ten. The specialty's own share is printed for information.
//
// Also checks that every key in QUESTION_CHOICES (options authored apart from
// their question) still matches a real prompt.
import { QUESTION_CHOICES, WRITTEN_ONLY_PROMPTS } from "../src/lib/question-bank/choices";
import { QUESTION_BANK, QUIZ_SPECIALTIES } from "../src/lib/technical-question-bank";
import { multipleChoiceTiers } from "../src/lib/practice-session";
import { QUIZ_DIFFICULTIES, CATEGORY_LABELS, ROUND_LENGTH, type QuizCategory } from "../src/lib/question-bank/types";

const prompts = new Set(Object.values(QUESTION_BANK).flat().map((q) => q.prompt));
const orphans = [...Object.keys(QUESTION_CHOICES), ...Object.keys(WRITTEN_ONLY_PROMPTS)].filter((k) => !prompts.has(k));

const all = Object.values(QUESTION_BANK).flat();
const withOptions = all.filter((q) => q.choices ?? QUESTION_CHOICES[q.prompt]).length;
console.log(`technical questions : ${all.length}`);
console.log(`with options        : ${withOptions} (${((withOptions / all.length) * 100).toFixed(0)}%)`);

const failures: string[] = [];
const pad = Math.max(...Object.values(CATEGORY_LABELS).map((l) => l.length));
console.log(`\nmultiple-choice questions per round pool (need ${ROUND_LENGTH}):`);
console.log(`${"".padEnd(pad)}  ${QUIZ_DIFFICULTIES.map((d) => d.slice(0, 5).padEnd(8)).join("")}`);

for (const category of Object.keys(QUESTION_BANK) as QuizCategory[]) {
  const cells = QUIZ_DIFFICULTIES.map((difficulty) => {
    const n = multipleChoiceTiers([category], {}, difficulty).flat().length;
    if (n < ROUND_LENGTH) failures.push(`  ${category}/${difficulty}: ${n} with options`);
    return String(n).padEnd(8);
  });
  console.log(`${CATEGORY_LABELS[category].padEnd(pad)}  ${cells.join("")}`);

  for (const specialty of QUIZ_SPECIALTIES[category]) {
    const cells = QUIZ_DIFFICULTIES.map((difficulty) => {
      const tiers = multipleChoiceTiers([category], { [category]: [specialty] }, difficulty);
      const own = tiers[0]?.filter((q) => QUESTION_BANK[category].some((b) => b.prompt === q.prompt && b.specialty === specialty)).length ?? 0;
      const reachable = tiers.flat().length;
      if (reachable < ROUND_LENGTH) failures.push(`  ${category}/${specialty}/${difficulty}: ${reachable} reachable`);
      return `${own}+`.padEnd(8);
    });
    console.log(`  ${specialty.slice(0, pad - 2).padEnd(pad - 2)}  ${cells.join("")}`);
  }
}
console.log(`\n(n+ = the specialty's own questions with options; the rest of a round tops up from the sector)`);

if (orphans.length) {
  console.error(`\nORPHANED KEYS (match no prompt):`);
  for (const o of orphans) console.error(`  - ${o.slice(0, 90)}`);
}
if (failures.length) {
  console.error(`\nPOOLS BELOW A FULL ROUND:`);
  for (const f of failures) console.error(f);
}
if (orphans.length || failures.length) process.exit(1);
console.log("\nevery sector and specialty can serve a full multiple-choice round at every difficulty.");
