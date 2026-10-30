import { EMAIL_EXAMPLES } from "../../src/lib/email-examples";
const all = Object.values(EMAIL_EXAMPLES).flat();
const STRAIGHT=/\b\w+'(s|t|re|ve|ll|d|m)\b/i;
const CURLY=/\b\w+’(s|t|re|ve|ll|d|m)\b/i;
const EITHER=/\b\w+['’](s|t|re|ve|ll|d|m)\b/i;
const count=(r:RegExp)=>all.filter(e=>r.test(e.body)).length;
console.log(`straight ' : ${count(STRAIGHT)} examples`);
console.log(`curly ’    : ${count(CURLY)} examples`);
console.log(`either     : ${count(EITHER)} examples  -> zero-contraction = ${all.length-count(EITHER)} = ${(100*(all.length-count(EITHER))/all.length).toFixed(1)}%   (PLAN-A §5: 144 = 75.0%)`);
const per=all.map(e=>(e.body.match(/\b\w+['’](s|t|re|ve|ll|d|m)\b/gi)??[]).length).sort((a,b)=>a-b);
console.log(`median ${per[Math.floor(per.length/2)]}, max ${per[per.length-1]}   (PLAN-A §5: median 0, max 2)`);
const coldAll=Object.entries(EMAIL_EXAMPLES).filter(([k])=>k.startsWith("cold_")).flatMap(([,v])=>v as any[]);
console.log(`cold_* zero-contraction: ${coldAll.filter(e=>!EITHER.test(e.body)).length} of ${coldAll.length}   (PLAN-A §5: 12 of 32)`);
// and the fixture corpora, both forms
import { readFileSync } from "node:fs"; import { join } from "node:path"; import { fileURLToPath } from "node:url";
const FIX=join(fileURLToPath(new URL(".",import.meta.url)),"..","draft-fixtures");
for(const f of ["occasion-drafts.txt","scenario-drafts-474.txt"]){
  const p=readFileSync(join(FIX,f),"utf8").split(/^=== (\d+)\s*$/m).slice(1); const bodies:string[]=[];
  for(let i=0;i<p.length;i+=2){const[,...r]=p[i+1].replace(/^\n/,"").split("\n"); if(r[0]?.startsWith("Notes:"))r.shift(); bodies.push(r.join("\n").trim());}
  const z=(r:RegExp)=>bodies.filter(b=>!r.test(b)).length;
  console.log(`${f}: n=${bodies.length} zero-contraction straight=${z(STRAIGHT)} curly-only-miss=${z(CURLY)} either=${z(EITHER)} (${(100*z(EITHER)/bodies.length).toFixed(0)}%)`);
}
