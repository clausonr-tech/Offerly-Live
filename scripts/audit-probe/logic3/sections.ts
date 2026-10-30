import { OCCASIONS } from "@/lib/draft-occasions";
for (const o of OCCASIONS) {
  console.log(`\n${o.id}`);
  for (const s of o.sections) console.log(`  [${s.mode}] ${s.title}: ${s.boxes.map((b) => `${b.id}(${b.typeId})`).join(", ")}`);
}
