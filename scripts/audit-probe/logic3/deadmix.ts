import volumeV from "@/lib/email-examples-v5.json";
import { boxesConflict, boxById, OCCASIONS, resolveSituation } from "@/lib/draft-occasions";
const V = volumeV as { sections: { section: number; title: string }[]; examples: { section: number; boxes: string[]; note: string }[] };
const occOf = (id: string) => OCCASIONS.find((o) => o.sections.some((s) => s.boxes.some((b) => b.id === id)))?.id ?? "???";
const mixes = new Map<string, { section: number; boxes: string[] }>();
for (const e of V.examples) mixes.set(e.boxes.join("+"), { section: e.section, boxes: e.boxes });
console.log("stored mixes and whether a student can actually check them:");
for (const [k, m] of mixes) {
  const occs = new Set(m.boxes.map(occOf));
  const unknown = m.boxes.filter((b) => !boxById(b));
  const conflict = m.boxes.flatMap((a) => m.boxes.filter((b) => a < b && boxesConflict(a, b)).map((b) => `${a}/${b}`));
  const r = occs.size === 1 ? resolveSituation([...occs][0], m.boxes) : { error: `spans occasions ${[...occs].join(",")}` };
  const ok = !("error" in r) && unknown.length === 0;
  console.log(`  ${ok ? "OK  " : "DEAD"} s${m.section} ${k}${unknown.length ? ` unknown=${unknown.join(",")}` : ""}${conflict.length ? ` conflicts=${conflict.join(",")}` : ""}${"error" in r ? ` err="${r.error}"` : ` lead=${r.lead.id}`}`);
}
console.log("\nsection titles:");
for (const s of V.sections) console.log(`  #${s.section} ${s.title}  (examples: ${V.examples.filter((e) => e.section === s.section).map((e) => e.boxes.join("+")).join(" | ") || "NONE"})`);
