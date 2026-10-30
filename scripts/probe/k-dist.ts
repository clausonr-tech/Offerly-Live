// TESTER-1: how many SENTENCES must a review touch? A deterministic floor on k,
// from only the voice failures PLAN-A itself enumerates in §5 and §R2.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const FIX = join(fileURLToPath(new URL(".", import.meta.url)), "..", "draft-fixtures");
const CPT=3.7; const tok=(s:string)=>s.length/CPT;
function parse(file: string){ const p=readFileSync(file,"utf8").split(/^=== (\d+)\s*$/m).slice(1); const o:{id:string;body:string;subject:string}[]=[];
  for(let i=0;i<p.length;i+=2){const [s,...r]=p[i+1].replace(/^\n/,"").split("\n"); if(r[0]?.startsWith("Notes:"))r.shift(); o.push({id:p[i],subject:s.replace(/^Subject:\s*/,""),body:r.join("\n").trim()});} return o; }
function editable(body: string){ const l=body.split("\n"); const c=l.findIndex(x=>/^\s*(Best|Thanks|Thank you|Sincerely|Warmly)[,.]?\s*$/i.test(x)); return l.slice(1,c<0?l.length:c).join("\n").trim(); }
function sents(t:string){ return t.split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(s=>s.length>1); }

const CANNED=[/for your reference/i,/I hope you are doing well/i,/I hope this email finds you well/i,/I attached (a copy of )?my resume/i,/I hope you'?re doing well/i];
const CONTRACTION=/\b\w+'(s|t|re|ve|ll|d|m)\b/i;
const FILLER=[/I wanted to reach out/i,/I wanted to follow up/i,/I just wanted to/i];

for (const [name,file] of [["occasion-drafts (87)","occasion-drafts.txt"],["scenario-drafts (474)","scenario-drafts-474.txt"]] as const) {
  const ds=parse(join(FIX,file));
  const ks:number[]=[]; const rows:{k:number;n:number;edTok:number;ss:string[]}[]=[];
  for(const d of ds){
    const ed=editable(d.body); const ss=sents(ed);
    const touch=new Set<number>();
    ss.forEach((s,i)=>{ if(CANNED.some(r=>r.test(s))||FILLER.some(r=>r.test(s))) touch.add(i); });
    // 3+ consecutive I-starts: breaking a run of L needs ceil((L-2)/2) rewrites, floor 1
    const iStart=ss.map(s=>/^I['’ ]/.test(s)||/^I$/.test(s));
    let run=0; for(let i=0;i<=iStart.length;i++){ if(iStart[i]) run++; else { if(run>=3) for(let j=i-run+1;j<i;j+=2) touch.add(j); run=0; } }
    // >50% I-starts: must vary at least enough to drop below half
    const nI=iStart.filter(Boolean).length;
    if(ss.length>0 && nI/ss.length>0.5){ const need=nI-Math.floor(ss.length/2); for(let j=0;j<ss.length&&touch.size<(touch.size+need);j++) if(iStart[j]) { touch.add(j); if([...touch].filter(x=>iStart[x]).length>=need) break; } }
    // zero contractions anywhere: the minimum intervention is one sentence
    if(ss.length>0 && !ss.some(s=>CONTRACTION.test(s))) touch.add(ss.findIndex(s=>/^I /.test(s))>=0?ss.findIndex(s=>/^I /.test(s)):0);
    ks.push(touch.size); rows.push({k:touch.size,n:ss.length,edTok:tok(ed),ss});
  }
  const hist=new Map<number,number>(); for(const k of ks) hist.set(k,(hist.get(k)??0)+1);
  const srt=[...ks].sort((a,b)=>a-b);
  console.log(`\n==== ${name} ====`);
  console.log(`k (sentences a VOICE_RULES-compliant review must touch): median ${srt[Math.floor(srt.length/2)]}, mean ${(ks.reduce((a,b)=>a+b,0)/ks.length).toFixed(2)}, max ${srt[srt.length-1]}`);
  console.log(`distribution: ${[...hist.entries()].sort((a,b)=>a[0]-b[0]).map(([k,v])=>`k=${k}: ${v} (${(100*v/ks.length).toFixed(0)}%)`).join(", ")}`);
  console.log(`drafts with k >= 2 (edits[] at or past break-even): ${ks.filter(k=>k>=2).length} / ${ks.length} = ${(100*ks.filter(k=>k>=2).length/ks.length).toFixed(0)}%`);
  console.log(`drafts with k >= 3: ${ks.filter(k=>k>=3).length} / ${ks.length} = ${(100*ks.filter(k=>k>=3).length/ks.length).toFixed(0)}%`);
  // actual payload comparison at each draft's own k
  let A=0,B=0, win=0;
  for(const r of rows){
    const picks=r.ss.slice(0,Math.min(r.k,r.ss.length));
    const probs=picks.map(x=>({kind:"flow",quote:x,fix:"reworded it",needsStudent:false}));
    const a=tok(JSON.stringify({problems:probs,subjectFix:null,edits:picks.map(x=>({find:x,replace:x}))}));
    const b=tok(JSON.stringify({problems:probs,subject:"A subject line of ordinary length",body:r.ss.join(" ")}));
    A+=a;B+=b; if(a<b)win++;
  }
  console.log(`at each draft's OWN k, with problems[] counted: edits ${(A/rows.length).toFixed(0)} tok vs whole ${(B/rows.length).toFixed(0)} tok => ${((1-A/B)*100>=0?"-":"+")}${Math.abs((1-A/B)*100).toFixed(0)}% ; edits[] is smaller on ${win}/${rows.length} drafts (${(100*win/rows.length).toFixed(0)}%)`);
}
