import { OCCASIONS, resolveSituation, situationTypes } from "../../src/lib/draft-occasions";
import { buildDraftPrompt } from "../../src/lib/draft-prompt";
import { sims } from "../draft-occasions-sim";
const BASE = sims()[0]; const CPT=3.7;
function subsets<T>(xs: T[]): T[][] { const o: T[][] = []; for (let m = 1; m < 1 << xs.length; m++) { const s: T[] = []; for (let i = 0; i < xs.length; i++) if (m & (1 << i)) s.push(xs[i]); o.push(s); } return o; }
const byOcc = new Map<string, number>(); const byCount = new Map<number, number>();
const leads3: string[] = []; const all: {occ:string;n:number;lead:string;boxes:string[];sys:number}[] = [];
for (const occ of OCCASIONS) {
  let k = 0;
  for (const c of subsets(occ.sections.flatMap(s=>s.boxes.map(b=>b.id)))) {
    const r = resolveSituation(occ.id, c); if ("error" in r) continue; k++;
    byCount.set(c.length, (byCount.get(c.length)??0)+1);
    const t = situationTypes(r);
    const sys = buildDraftPrompt({...BASE.input, type:t[0].id, alsoTypes:t.slice(1).map(x=>x.id), boxIds:c, situationSummary:r.summary}).system;
    all.push({occ:occ.id,n:c.length,lead:t[0].id,boxes:c,sys:sys.length});
    if (c.length>=3) leads3.push(`${occ.id} ${c.length}box ${t[0].id} [${c.join("+")}]`);
  }
  byOcc.set(occ.id, k);
}
console.log("per-occasion valid combinations:", [...byOcc.entries()].map(([k,v])=>`${k} ${v}`).join(", "), "| total", [...byOcc.values()].reduce((a,b)=>a+b,0));
console.log("by box count:", [...byCount.entries()].sort((a,b)=>a[0]-b[0]).map(([k,v])=>`${k} boxes: ${v}`).join(", "));
console.log("\ncombinations with >=3 boxes:", leads3.length);
for (const l of leads3) console.log("  ", l);
console.log("\nany combination whose LEAD is cold_email with >=2 boxes:");
for (const a of all.filter(x=>x.lead==="cold_email"&&x.n>=2)) console.log(`   ${a.n} boxes [${a.boxes.join("+")}] system ${a.sys} ch / ~${Math.round(a.sys/CPT)} tok`);
console.log("\nlargest system prompts:");
for (const a of all.sort((x,y)=>y.sys-x.sys).slice(0,5)) console.log(`   ${a.sys} ch lead=${a.lead} [${a.boxes.join("+")}]`);
