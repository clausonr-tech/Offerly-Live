import { OCCASIONS } from "@/lib/draft-occasions";
import { emailTypeById } from "@/lib/draft-templates";
for (const o of OCCASIONS) {
  if (!["thanks", "stay", "first_contact"].includes(o.id)) continue;
  for (const s of o.sections) for (const b of s.boxes) {
    const t = emailTypeById(b.typeId)!;
    console.log(`${b.id}\n  label: ${b.label}\n  excludes: ${(b.excludes ?? []).join(",") || "-"}  presets: ${JSON.stringify(b.presets ?? {})}`);
    console.log(`  type ${t.id}: maxWords=${t.maxWords} isCold=${!!t.isCold} repliesInThread=${!!t.repliesInThread} attachResume=${!!t.attachResume}`);
    console.log(`  format: ${t.format.map((f, i) => `${i + 1}) ${f}`).join(" | ")}`);
  }
}
