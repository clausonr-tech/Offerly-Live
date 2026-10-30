import { EMAIL_EXAMPLES } from "../../src/lib/email-examples";
const C=/\b\w+'(s|t|re|ve|ll|d|m)\b/i;
const CANNED=[/for your reference/i,/I hope you are doing well/i,/I hope this email finds you well/i,/I attached my resume/i];
const all = Object.values(EMAIL_EXAMPLES).flat();
let zero=0, canned=0; const per:number[]=[];
for(const e of all){ const t=e.body; const m=t.match(/\b\w+'(s|t|re|ve|ll|d|m)\b/gi)??[]; per.push(m.length); if(m.length===0)zero++; if(CANNED.some(r=>r.test(t)))canned++; }
per.sort((a,b)=>a-b);
console.log(`examples: ${all.length}`);
console.log(`zero contractions: ${zero} = ${(100*zero/all.length).toFixed(1)}%   (PLAN-A §5: 144 = 75.0%)`);
console.log(`median contractions/example: ${per[Math.floor(per.length/2)]}, max ${per[per.length-1]}   (PLAN-A §5: median 0, max 2)`);
console.log(`contain a banned canned line: ${canned} = ${(100*canned/all.length).toFixed(1)}%   (PLAN-A §5: 62 = 32.3%)`);
console.log(`canned-free: ${all.length-canned}/${all.length} = ${(100*(all.length-canned)/all.length).toFixed(1)}%   (PLAN-A test-1 baseline: 130/192 = 67.7%)`);
console.log(`with >=1 contraction: ${all.length-zero}/${all.length} = ${(100*(all.length-zero)/all.length).toFixed(1)}%   (PLAN-A test-1 baseline: 48/192 = 25.0%)`);
const cold = (EMAIL_EXAMPLES as any)["cold_email"]??[]; const coldZero = cold.filter((e:any)=>!C.test(e.body)).length;
console.log(`cold_* examples with zero contractions: ${Object.entries(EMAIL_EXAMPLES).filter(([k])=>k.startsWith("cold_")).flatMap(([,v])=>v as any[]).filter((e:any)=>!C.test(e.body)).length} of ${Object.entries(EMAIL_EXAMPLES).filter(([k])=>k.startsWith("cold_")).flatMap(([,v])=>v as any[]).length}   (PLAN-A §5: 12 of 32)`);
