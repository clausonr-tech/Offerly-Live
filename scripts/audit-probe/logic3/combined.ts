// LOGIC-3 probe: combinedExamplesFor coverage across every valid combination.
import { combinedExamplesFor } from "@/lib/draft-prompt";
import volumeV from "@/lib/email-examples-v5.json";
import { allCombos } from "./enumerate";

const V = volumeV as { sections: { section: number; title: string }[]; examples: { section: number; boxes: string[]; note: string }[] };
console.log(`Volume V: ${V.sections.length} sections, ${V.examples.length} examples`);
const mixSizes = new Map<number, number>();
for (const e of V.examples) mixSizes.set(e.boxes.length, (mixSizes.get(e.boxes.length) ?? 0) + 1);
console.log("stored examples by mix size:", [...mixSizes].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}:${c}`).join("  "));
const storedMixes = new Set(V.examples.map((e) => [...e.boxes].sort().join("+")));
console.log(`distinct stored mixes: ${storedMixes.size}`);

const combos = allCombos().filter((c) => c.ids.length >= 2);
let withExamples = 0, exact = 0;
const lostToLeadRule: string[] = [];
const noneAtAll: string[] = [];
const shownSections = new Set<number>();
for (const c of combos) {
  const boxIds = [c.sit.lead, ...c.sit.also].map((b) => b.id);
  const r = combinedExamplesFor(boxIds);
  r.sections.forEach((s) => shownSections.add(s.section));
  if (r.examples.length > 0) { withExamples++; if (r.exact) exact++; }
  const checked = new Set(boxIds);
  // Any stored mix of >=2 boxes fully inside what the student checked?
  const containable = V.examples.filter((e) => e.boxes.length >= 2 && e.boxes.every((b) => checked.has(b)));
  if (r.examples.length === 0) {
    if (containable.length > 0) {
      lostToLeadRule.push(
        `[${boxIds.join(",")}] lead=${boxIds[0]}  stored-but-unused mixes: ${[...new Set(containable.map((e) => e.boxes.join("+")))].join(" ; ")}`,
      );
    } else noneAtAll.push(`[${boxIds.join(",")}]`);
  }
}
console.log(`\nmulti-box combinations: ${combos.length}`);
console.log(`  with >=1 combination example: ${withExamples}`);
console.log(`  flagged "exactly this mix" (exact=true): ${exact}`);
console.log(`  with NO combination example: ${combos.length - withExamples}`);
console.log(`\n--- NO example although a fully-checked stored mix exists (dropped by the "includes the lead" rule): ${lostToLeadRule.length}`);
lostToLeadRule.forEach((l) => console.log("  " + l));
console.log(`\n--- NO example and no stored mix fits at all: ${noneAtAll.length}`);
console.log("  " + noneAtAll.join("  "));
console.log(`\nsections ever shown: ${[...shownSections].sort((a, b) => a - b).join(",")}`);
console.log("sections NEVER shown to any student:");
for (const s of V.sections) if (!shownSections.has(s.section)) console.log(`  #${s.section} ${s.title}`);
