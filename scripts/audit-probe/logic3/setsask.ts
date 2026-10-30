// LOGIC-3 probe: what SETS_THE_ASK drops and keeps among the lines a SECONDARY
// box can contribute. Secondary lines = that type's promptNotes + its
// switch-case lines (briefLines with mode.shared === false).
import { SETS_THE_ASK } from "@/lib/draft-prompt";
import { emailTypeById } from "@/lib/draft-templates";
import { allCombos } from "./enumerate";

// Which typeIds ever appear as a non-lead box?
const secondary = new Map<string, Set<string>>();
for (const c of allCombos()) {
  for (const b of c.sit.also) {
    if (b.typeId === c.sit.lead.typeId) continue;
    if (!secondary.has(b.typeId)) secondary.set(b.typeId, new Set());
    secondary.get(b.typeId)!.add(`${c.sit.lead.typeId}<-${b.typeId}`);
  }
}
console.log(`typeIds that ever appear as a secondary box: ${secondary.size}`);
console.log([...secondary.keys()].join(", "));

console.log("\n=== promptNotes of every secondary type, with the SETS_THE_ASK verdict ===");
let dropped = 0, kept = 0;
for (const t of [...secondary.keys()].sort()) {
  const type = emailTypeById(t as never)!;
  console.log(`\n-- ${t} (maxWords ${type.maxWords})`);
  for (const n of type.promptNotes ?? []) {
    const line = n.replaceAll("{firm}", "the firm").replaceAll("{name}", "Dana Reed");
    const hit = SETS_THE_ASK.test(line);
    if (hit) dropped++; else kept++;
    console.log(`   [${hit ? "DROP" : "keep"}] ${line}`);
  }
}
console.log(`\npromptNotes across secondary types: ${dropped} dropped, ${kept} kept`);
