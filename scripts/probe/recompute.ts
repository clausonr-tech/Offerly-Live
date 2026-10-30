// TESTER-1: recompute every MEASURED number in PLAN-A §0/§1.
import { OCCASIONS, resolveSituation, situationTypes } from "../../src/lib/draft-occasions";
import { EMAIL_TYPES, emailTypeById, type EmailTypeId } from "../../src/lib/draft-templates";
import { buildDraftPrompt, type DraftPromptInput } from "../../src/lib/draft-prompt";
import { buildReviewPrompt } from "../../src/lib/draft-review";
import { EMAIL_EXAMPLES } from "../../src/lib/email-examples";
import { sims } from "../draft-occasions-sim";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CPT = 3.7; const tok = (s: string) => Math.round(s.length / CPT);
const BASE = sims()[0];
const HEAD_END = "- Then write the body from the plan, sentence for sentence.";
const TAIL_START = "\n\nFINDING COMMON GROUND";
const CEIL = /\nHARD CEILING: \d+ words in the body, signature excluded\. A ceiling, not a target\./;

function split(system: string) {
  const h = system.indexOf(HEAD_END) + HEAD_END.length;
  const t = system.lastIndexOf(TAIL_START);
  return { head: system.slice(0, h + 2), mid: system.slice(h + 2, t + 2), tail: system.slice(t + 2) };
}

console.log("=== §1 table: 'system total / invariant head / per-type+mix / invariant tail / user' ===");
const situations: { name: string; input: DraftPromptInput }[] = [
  { name: "cold_email, 1 box", input: { ...BASE.input, type: "cold_email", alsoTypes: [], boxIds: ["first.alum"] } },
  { name: "thank_you_chat", input: { ...BASE.input, type: "thank_you_chat", alsoTypes: [], boxIds: [] } },
  { name: "custom", input: { ...BASE.input, type: "custom", alsoTypes: [], boxIds: [] } },
  { name: "follow_up_1", input: { ...BASE.input, type: "follow_up_1", alsoTypes: [], boxIds: [] } },
];
for (const s of situations) {
  const { system, userText } = buildDraftPrompt(s.input);
  const p = split(system);
  console.log(`${s.name.padEnd(20)} total ${system.length} ch/~${tok(system)} tok | head ${p.head.length}/~${tok(p.head)} | mid ${p.mid.length}/~${tok(p.mid)} | tail ${p.tail.length}/~${tok(p.tail)} | user ${userText.length} ch/~${tok(userText)} tok`);
}
// cold_email 3 boxes: find a 3-box combination leading cold_email
let three: { boxIds: string[]; also: EmailTypeId[] } | null = null;
function subsets<T>(xs: T[]): T[][] { const o: T[][] = []; for (let m = 1; m < 1 << xs.length; m++) { const s: T[] = []; for (let i = 0; i < xs.length; i++) if (m & (1 << i)) s.push(xs[i]); o.push(s); } return o; }
for (const occ of OCCASIONS) for (const c of subsets(occ.sections.flatMap(s=>s.boxes.map(b=>b.id)))) {
  if (c.length !== 3) continue; const r = resolveSituation(occ.id, c); if ("error" in r) continue;
  const t = situationTypes(r); if (t[0].id !== "cold_email") continue;
  three = { boxIds: c, also: t.slice(1).map(x=>x.id) }; break;
}
if (three) {
  const { system, userText } = buildDraftPrompt({ ...BASE.input, type: "cold_email", alsoTypes: three.also, boxIds: three.boxIds });
  const p = split(system);
  console.log(`cold_email, 3 boxes  total ${system.length} ch/~${tok(system)} tok | head ${p.head.length}/~${tok(p.head)} | mid ${p.mid.length}/~${tok(p.mid)} | tail ${p.tail.length}/~${tok(p.tail)} | user ${userText.length}/~${tok(userText)}  [${three.boxIds.join("+")}]`);
}

console.log("\n=== review prompt (plan: 11,682 ch / ~3,157 tok system; ~268 tok user) ===");
const FIX = join(fileURLToPath(new URL(".", import.meta.url)), "..", "draft-fixtures", "occasion-drafts.txt");
const parts = readFileSync(FIX, "utf8").split(/^=== (\d+)\s*$/m).slice(1);
const drafts = new Map<string, { subject: string; body: string }>();
for (let i = 0; i < parts.length; i += 2) {
  const [sub, ...rest] = parts[i+1].replace(/^\n/, "").split("\n");
  if (rest[0]?.startsWith("Notes:")) rest.shift();
  drafts.set(parts[i], { subject: sub.replace(/^Subject:\s*/, ""), body: rest.join("\n").trim() });
}
const d0 = drafts.get(BASE.id)!;
const rp = buildReviewPrompt(BASE.input, { subject: d0.subject, body: d0.body }, []);
const rsys = typeof rp === "string" ? rp : (rp as any).system;
const ruser = typeof rp === "string" ? "" : (rp as any).userText;
console.log(`review system ${rsys.length} ch / ~${tok(rsys)} tok ; review user ${ruser.length} ch / ~${tok(ruser)} tok`);
// review user over all 87 fixtures
const ru: number[] = [];
for (const s of sims()) { const d = drafts.get(s.id); if (!d) continue; const r: any = buildReviewPrompt(s.input, { subject: d.subject, body: d.body }, []); ru.push(r.userText.length); }
ru.sort((a,b)=>a-b);
console.log(`review user over ${ru.length} fixtures: min ${ru[0]} ch/~${Math.round(ru[0]/CPT)} tok, median ${ru[Math.floor(ru.length/2)]}/~${Math.round(ru[Math.floor(ru.length/2)]/CPT)}, max ${ru[ru.length-1]}/~${Math.round(ru[ru.length-1]/CPT)}`);
const rsysSet = new Set<string>(); for (const s of sims()) { const d = drafts.get(s.id); if (!d) continue; const r: any = buildReviewPrompt(s.input, { subject: d.subject, body: d.body }, []); rsysSet.add(r.system); }
console.log(`distinct review SYSTEM strings over ${ru.length} fixtures: ${rsysSet.size}`);

console.log("\n=== mid-tier breakdown, cold_email (plan: format 843, blend 1758, examples 10660, combined 5362) ===");
function pieces(input: DraftPromptInput) {
  const { system } = buildDraftPrompt(input);
  const { mid } = split(system);
  const m = mid.slice(0, -2);
  const idxBlend = m.indexOf("SEVERAL THINGS ARE TRUE AT ONCE.");
  const idxEx = m.indexOf("EXAMPLES - ");
  const idxEx2 = m.indexOf("EXAMPLES: none yet");
  const idxComb = m.indexOf("COMBINATION FORMAT - how the playbook folds");
  const marks = [["format",0],["blend",idxBlend],["examples",Math.max(idxEx,idxEx2)],["combined",idxComb]]
    .filter(([,i]) => (i as number) >= 0).sort((a,b)=>(a[1] as number)-(b[1] as number)) as [string,number][];
  const out: Record<string,number> = {};
  for (let i=0;i<marks.length;i++){ const end = i+1<marks.length?marks[i+1][1]-2:m.length; out[marks[i][0]] = end - marks[i][1]; }
  return out;
}
console.log("1 box :", pieces({ ...BASE.input, type: "cold_email", alsoTypes: [], boxIds: ["first.alum"] }));
if (three) console.log("3 boxes:", pieces({ ...BASE.input, type: "cold_email", alsoTypes: three.also, boxIds: three.boxIds }));

console.log("\n=== system prompt size distribution over the 107 combinations (plan: min 11,100 p50 16,555 p90 24,068 max 32,974) ===");
const sizes: number[] = [];
for (const occ of OCCASIONS) for (const c of subsets(occ.sections.flatMap(s=>s.boxes.map(b=>b.id)))) {
  const r = resolveSituation(occ.id, c); if ("error" in r) continue;
  const t = situationTypes(r);
  sizes.push(buildDraftPrompt({ ...BASE.input, type: t[0].id, alsoTypes: t.slice(1).map(x=>x.id), boxIds: c, situationSummary: r.summary }).system.length);
}
sizes.sort((a,b)=>a-b);
const q=(p:number)=>sizes[Math.min(sizes.length-1,Math.floor(p*sizes.length))];
console.log(`n=${sizes.length} min ${sizes[0]} p50 ${q(0.5)} p90 ${q(0.9)} max ${sizes[sizes.length-1]}`);

console.log("\n=== examples (plan: 192 examples, 145,478 ch; cold_email 9/9,797; block 10,660; smallest stalled_thread_nudge 2/1,117) ===");
let n=0, ch=0; const per: [string,number,number][] = [];
for (const [k,v] of Object.entries(EMAIL_EXAMPLES)) { n += v.length; const c = v.reduce((a,e)=>a+e.subject.length+e.body.length,0); ch += c; per.push([k,v.length,c]); }
console.log(`total examples ${n}; summed subject+body chars ${ch}`);
per.sort((a,b)=>b[2]-a[2]);
console.log("largest 5 by chars:", per.slice(0,5).map(p=>`${p[0]} ${p[1]}/${p[2]}`).join(", "));
console.log("smallest 3:", per.filter(p=>p[1]>0).slice(-3).map(p=>`${p[0]} ${p[1]}/${p[2]}`).join(", "));

console.log("\n=== custom 40-format dump (plan: 23,527 ch / ~6,359 tok; per-format min 391 median 580 max 874) ===");
const cust = buildDraftPrompt({ ...BASE.input, type: "custom", alsoTypes: [], boxIds: [] }).system;
const cm = split(cust).mid.slice(0,-2);
console.log(`custom mid block (formatBlock('custom')) = ${cm.length} ch / ~${tok(cm)} tok`);
const fsizes = EMAIL_TYPES.filter(t=>t.id!=="custom").map(t=>`${t.label} (${t.timing})\n${t.format.map((s,i)=>`  ${i+1}. ${s}`).join("\n")}`.length).sort((a,b)=>a-b);
console.log(`non-custom types: ${fsizes.length}; per-format chars min ${fsizes[0]} median ${fsizes[Math.floor(fsizes.length/2)]} max ${fsizes[fsizes.length-1]}; summed ${fsizes.reduce((a,b)=>a+b,0)}`);

console.log("\n=== ceiling-line removal: is it needed to get 41 perType keys? ===");
const ptWith = new Set<string>(), ptWithout = new Set<string>();
for (const occ of OCCASIONS) for (const c of subsets(occ.sections.flatMap(s=>s.boxes.map(b=>b.id)))) {
  const r = resolveSituation(occ.id, c); if ("error" in r) continue;
  const t = situationTypes(r);
  const sys = buildDraftPrompt({ ...BASE.input, type: t[0].id, alsoTypes: t.slice(1).map(x=>x.id), boxIds: c, situationSummary: r.summary }).system;
  const m = split(sys).mid.slice(0,-2);
  const ib = m.indexOf("SEVERAL THINGS ARE TRUE AT ONCE.");
  const fmt = ib >= 0 ? m.slice(0, ib-2) : (()=>{const ie=Math.max(m.indexOf("EXAMPLES - "), m.indexOf("EXAMPLES: none yet")); return ie>=0?m.slice(0,ie-2):m;})();
  ptWith.add(fmt + "|" + t[0].id);
  ptWithout.add(fmt.replace(CEIL, "") + "|" + t[0].id);
}
console.log(`distinct formatBlock values WITH ceiling line: ${ptWith.size}; WITHOUT: ${ptWithout.size} (41 lead types)`);
