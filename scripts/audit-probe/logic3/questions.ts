// LOGIC-3 probe: situationQuestions across every valid combination.
import { QUESTION_MERGES, situationQuestions, aliasesOf } from "@/lib/draft-occasions";
import { allCombos } from "./enumerate";
let dupes = 0, aliasDupes = 0, twoMerges = 0, mergeApplied = 0;
const notes: string[] = [];
for (const c of allCombos()) {
  const ids = new Set([c.sit.lead, ...c.sit.also].map((b) => b.id));
  const qs = situationQuestions(c.sit, () => undefined);
  const names = qs.map((q) => q.name);
  const seen = new Set<string>();
  for (const n of names) { if (seen.has(n)) { dupes++; notes.push(`dup name ${n} in [${[...ids].join(",")}]`); } seen.add(n); }
  for (const n of names) for (const a of aliasesOf(n)) if (names.includes(a)) { aliasDupes++; notes.push(`alias pair ${n}/${a} both asked in [${[...ids].join(",")}]`); }
  const fire = QUESTION_MERGES.filter((m) => m.boxes.every((id) => ids.has(id)));
  if (fire.length) mergeApplied++;
  if (fire.length > 1) { twoMerges++; notes.push(`TWO MERGES fire in [${[...ids].join(",")}]: ${fire.map((m) => `${m.keep}<-${m.drop}`).join(" , ")}`); }
  // Did a merge that fired actually take effect?
  for (const m of fire) {
    if (names.includes(m.drop)) notes.push(`merge ${m.keep}<-${m.drop} fired but ${m.drop} is still asked in [${[...ids].join(",")}]`);
    if (!names.includes(m.keep)) notes.push(`merge ${m.keep}<-${m.drop} fired but ${m.keep} is NOT asked in [${[...ids].join(",")}]`);
  }
}
console.log(`combinations: ${allCombos().length}`);
console.log(`duplicate question names: ${dupes}`);
console.log(`alias pairs both asked: ${aliasDupes}`);
console.log(`combinations where a QUESTION_MERGE applies: ${mergeApplied}`);
console.log(`combinations where TWO merges apply: ${twoMerges}`);
console.log(`\nnotes (${notes.length}):`);
[...new Set(notes)].forEach((n) => console.log("  " + n));
