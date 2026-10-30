// TESTER-1: PLAN-A §5 MEASURES 56% of the 474-draft corpus at ZERO contractions and
// says VOICE_RULES tells the reviewer to "use them naturally". How many SENTENCES
// does that touch? Count sentences holding a contractible full form.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const FIX = join(fileURLToPath(new URL(".", import.meta.url)), "..", "draft-fixtures");
const CPT=3.7; const tok=(s:string)=>s.length/CPT;
function parse(f:string){const p=readFileSync(f,"utf8").split(/^=== (\d+)\s*$/m).slice(1);const o:{id:string;body:string}[]=[];for(let i=0;i<p.length;i+=2){const [s,...r]=p[i+1].replace(/^\n/,"").split("\n");if(r[0]?.startsWith("Notes:"))r.shift();o.push({id:p[i],body:r.join("\n").trim()});}return o;}
function editable(b:string){const l=b.split("\n");const c=l.findIndex(x=>/^\s*(Best|Thanks|Thank you|Sincerely|Warmly)[,.]?\s*$/i.test(x));return l.slice(1,c<0?l.length:c).join("\n").trim();}
function sents(t:string){return t.split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(s=>s.length>1);}
const CONTRACTION=/\b\w+'(s|t|re|ve|ll|d|m)\b/i;
// the full forms VOICE_RULES names: I'm, I'd, don't, it's -- plus the obvious rest
const FULL=/\b(I am|I would|I have|I will|I had|do not|does not|did not|is not|are not|was not|were not|cannot|can not|it is|that is|there is|you are|they are|we are|would not|could not|should not|will not|I he?ve)\b/i;

for (const [name,file] of [["occasion-drafts (87)","occasion-drafts.txt"],["scenario-drafts (474)","scenario-drafts-474.txt"]] as const) {
  const ds=parse(join(FIX,file));
  let zero=0; const ks:number[]=[]; const rows:{k:number;ss:string[]}[]=[];
  for(const d of ds){
    const ss=sents(editable(d.body));
    const has=ss.some(s=>CONTRACTION.test(s));
    if(has) continue;
    zero++;
    const touch=ss.filter(s=>FULL.test(s)).length;
    ks.push(touch); rows.push({k:touch,ss});
  }
  const srt=[...ks].sort((a,b)=>a-b);
  console.log(`\n==== ${name} ====`);
  console.log(`drafts with ZERO contractions: ${zero}/${ds.length} = ${(100*zero/ds.length).toFixed(0)}%   (PLAN-A §5 MEASURED 56% on the 474 corpus)`);
  if(!ks.length){console.log("  none");continue;}
  console.log(`of those, sentences holding a contractible full form (= k the reviewer must touch to comply):`);
  console.log(`  median ${srt[Math.floor(srt.length/2)]}, mean ${(ks.reduce((a,b)=>a+b,0)/ks.length).toFixed(2)}, max ${srt[srt.length-1]}`);
  const hist=new Map<number,number>(); for(const k of ks) hist.set(k,(hist.get(k)??0)+1);
  console.log(`  distribution: ${[...hist.entries()].sort((a,b)=>a[0]-b[0]).map(([k,v])=>`k=${k}: ${v}`).join(", ")}`);
  console.log(`  k>=2: ${ks.filter(k=>k>=2).length}/${ks.length} = ${(100*ks.filter(k=>k>=2).length/ks.length).toFixed(0)}% ; k>=3: ${(100*ks.filter(k=>k>=3).length/ks.length).toFixed(0)}%`);
  let A=0,B=0,win=0;
  for(const r of rows){
    const picks=r.ss.filter(s=>FULL.test(s));
    const probs=picks.slice(0,3).map(x=>({kind:"tone",quote:x,fix:"used contractions",needsStudent:false}));
    const a=tok(JSON.stringify({problems:probs,subjectFix:null,edits:picks.map(x=>({find:x,replace:x}))}));
    const b=tok(JSON.stringify({problems:probs,subject:"A subject line of ordinary length",body:r.ss.join(" ")}));
    A+=a;B+=b; if(a<b)win++;
  }
  console.log(`  payload on these zero-contraction drafts: edits ${(A/rows.length).toFixed(0)} tok vs whole ${(B/rows.length).toFixed(0)} tok => ${((1-A/B)*100>=0?"-":"+")}${Math.abs((1-A/B)*100).toFixed(0)}% ; edits[] smaller on ${win}/${rows.length} (${(100*win/rows.length).toFixed(0)}%)`);
}
