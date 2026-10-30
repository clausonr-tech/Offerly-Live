import { OCCASIONS, resolveSituation, situationQuestions, situationTypes, type Situation } from "../../../src/lib/draft-occasions";
import { EMAIL_TYPES } from "../../../src/lib/draft-templates";
const valid: { occ: string; boxes: string[]; s: Situation }[] = [];
for (const o of OCCASIONS) { const ids = o.sections.flatMap((s) => s.boxes).map((b) => b.id);
  for (let m = 1; m < 2 ** ids.length; m++) { const pick = ids.filter((_, i) => m & (1 << i)); const r = resolveSituation(o.id, pick); if (!("error" in r)) valid.push({ occ: o.id, boxes: pick, s: r }); } }
console.log("## types with repliesInThread:", EMAIL_TYPES.filter(t=>t.repliesInThread).map(t=>t.id).join(", "));
console.log("## types with a threadSubject field:", EMAIL_TYPES.filter(t=>(t.fields??[]).some(f=>f.name==="threadSubject")).map(t=>`${t.id}${t.repliesInThread?" (repliesInThread!)":""}`).join(", "));
console.log("## types with isCold:", EMAIL_TYPES.filter(t=>t.isCold).map(t=>t.id).join(", "));
console.log("\n## combinations asking for a subject line more than once");
let n=0;
for (const c of valid) {
  const qs = situationQuestions(c.s, (x) => c.s.presets[x] ?? undefined);
  const subj = qs.filter(q=>/subject/i.test(q.label));
  if (subj.length > 1) { n++; console.log(`  ${c.occ}[${c.boxes.join("+")}] types=${situationTypes(c.s).map(t=>t.id).join("/")}`); for (const q of subj) console.log(`      ${q.required?"*":" "} ${q.name.padEnd(16)} ${JSON.stringify(q.label)} ${q.prompt?"":"(brief only)"}`); }
}
console.log(`  total: ${n}`);
console.log("\n## every repliesInThread combination's question set");
for (const c of valid) { const types = situationTypes(c.s); if (!types.some(t=>t.repliesInThread)) continue;
  const qs = situationQuestions(c.s, (x) => c.s.presets[x] ?? undefined);
  console.log(`  ${c.occ}[${c.boxes.join("+")}] types=${types.map(t=>t.id).join("/")}: ${qs.map(q=>`${q.name}${q.required?"*":""}`).join(" ")}`); }
console.log("\n## label pairs that read like the same question (manual review list)");
const seen = new Set<string>();
for (const c of valid) { const qs = situationQuestions(c.s, (x) => c.s.presets[x] ?? undefined);
  for (let i=0;i<qs.length;i++) for (let j=i+1;j<qs.length;j++) {
    const w = (s:string)=>new Set(s.toLowerCase().replace(/[^a-z ]/g,"").split(/\s+/).filter(x=>x.length>3));
    const A=w(qs[i].label), B=w(qs[j].label); const inter=[...A].filter(x=>B.has(x));
    if (inter.length>=2 && inter.length/Math.min(A.size,B.size) >= 0.5) { const k=`${qs[i].name}|${qs[j].name}`; if(!seen.has(k)){seen.add(k); console.log(`  ${qs[i].name} ${JSON.stringify(qs[i].label)}  ~  ${qs[j].name} ${JSON.stringify(qs[j].label)}   [first seen in ${c.occ}[${c.boxes.join("+")}]]`);} }
  } }
