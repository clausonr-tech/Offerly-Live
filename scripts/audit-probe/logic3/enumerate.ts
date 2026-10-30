// LOGIC-3 probe: enumerate every combination resolveSituation accepts.
import { OCCASIONS, resolveSituation, type Situation } from "@/lib/draft-occasions";

export type Combo = { occasion: string; ids: string[]; sit: Situation };

export function allCombos(): Combo[] {
  const out: Combo[] = [];
  for (const o of OCCASIONS) {
    const boxes = o.sections.flatMap((s) => s.boxes).map((b) => b.id);
    for (let mask = 1; mask < 1 << boxes.length; mask++) {
      const ids = boxes.filter((_, i) => mask & (1 << i));
      const sit = resolveSituation(o.id, ids);
      if ("error" in sit) continue;
      out.push({ occasion: o.id, ids, sit });
    }
  }
  return out;
}

if (require.main === module) {
  const combos = allCombos();
  console.log(`valid combinations total: ${combos.length}`);
  const bySize = new Map<number, number>();
  for (const c of combos) bySize.set(c.ids.length, (bySize.get(c.ids.length) ?? 0) + 1);
  console.log("by box count:", [...bySize].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}:${c}`).join("  "));
  const byOcc = new Map<string, number>();
  for (const c of combos) byOcc.set(c.occasion, (byOcc.get(c.occasion) ?? 0) + 1);
  console.log("by occasion:", [...byOcc].map(([o, c]) => `${o}:${c}`).join("  "));
  const multi = combos.filter((c) => c.ids.length >= 2);
  console.log(`multi-box: ${multi.length}`);
  // Which lead types ever lead a multi-box situation?
  const leadTypes = new Map<string, number>();
  for (const c of multi) leadTypes.set(c.sit.lead.typeId, (leadTypes.get(c.sit.lead.typeId) ?? 0) + 1);
  console.log("multi-box lead typeIds:", [...leadTypes].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}:${n}`).join("  "));
  const leadTypesAll = new Map<string, number>();
  for (const c of combos) leadTypesAll.set(c.sit.lead.typeId, (leadTypesAll.get(c.sit.lead.typeId) ?? 0) + 1);
  console.log("all-combo lead typeIds:", [...leadTypesAll].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}:${n}`).join("  "));
}
