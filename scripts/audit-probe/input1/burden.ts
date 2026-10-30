import { OCCASIONS, resolveSituation, situationQuestions, situationTypes, type Situation } from "../../../src/lib/draft-occasions";
const valid: { k: string; s: Situation }[] = [];
for (const o of OCCASIONS) { const ids = o.sections.flatMap((s) => s.boxes).map((b) => b.id);
  for (let m = 1; m < 2 ** ids.length; m++) { const p = ids.filter((_, i) => m & (1 << i)); const r = resolveSituation(o.id, p); if (!("error" in r)) valid.push({ k: `${o.id}[${p.join("+")}]`, s: r }); } }
const rows = valid.map(({ k, s }) => { const qs = situationQuestions(s, (n) => s.presets[n] ?? undefined); return { k, q: qs.length, req: qs.filter((x) => x.required).length, types: situationTypes(s).length }; });
console.log("combinations with NO required question:", rows.filter(r=>!r.req).map(r=>r.k).join(", ") || "none");
console.log("question count distribution:", JSON.stringify(Object.fromEntries([...new Set(rows.map(r=>r.q))].sort((a,b)=>a-b).map(n=>[n, rows.filter(r=>r.q===n).length]))));
console.log("required count distribution:", JSON.stringify(Object.fromEntries([...new Set(rows.map(r=>r.req))].sort((a,b)=>a-b).map(n=>[n, rows.filter(r=>r.req===n).length]))));
console.log("types-per-situation distribution:", JSON.stringify(Object.fromEntries([...new Set(rows.map(r=>r.types))].sort((a,b)=>a-b).map(n=>[n, rows.filter(r=>r.types===n).length]))));
console.log("\nheaviest 8 by required count:"); for (const r of [...rows].sort((a,b)=>b.req-a.req||b.q-a.q).slice(0,8)) console.log(`  ${r.req} required / ${r.q} questions / ${r.types} types  ${r.k}`);
