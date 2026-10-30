// LOGIC-3 probe: the word ceiling a mix produces, against the lead's own.
import { emailTypeById } from "@/lib/draft-templates";
import { allCombos } from "./enumerate";
const rows: { ids: string[]; lead: string; leadMax: number; ceiling: number }[] = [];
for (const c of allCombos()) {
  if (c.ids.length < 2) continue;
  const types = [c.sit.lead, ...c.sit.also].map((b) => b.typeId);
  const leadMax = emailTypeById(types[0])!.maxWords;
  const ceiling = Math.max(...types.map((t) => emailTypeById(t)!.maxWords));
  rows.push({ ids: [c.sit.lead, ...c.sit.also].map((b) => b.id), lead: types[0], leadMax, ceiling });
}
rows.sort((a, b) => b.ceiling - b.leadMax - (a.ceiling - a.leadMax));
console.log(`multi-box combinations: ${rows.length}`);
console.log(`ceiling > the lead type's own maxWords in ${rows.filter((r) => r.ceiling > r.leadMax).length} of them`);
console.log(`ceiling < the lead's own in ${rows.filter((r) => r.ceiling < r.leadMax).length} (should be 0 by construction)`);
console.log("\nlargest loosenings:");
for (const r of rows.slice(0, 10)) console.log(`  +${r.ceiling - r.leadMax}  lead=${r.lead} (${r.leadMax}) -> ceiling ${r.ceiling}  [${r.ids.join(",")}]`);
