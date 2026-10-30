import { EMAIL_TYPES } from "../../src/lib/draft-templates";
import { EMAIL_EXAMPLES } from "../../src/lib/email-examples";
const CPT=3.7, tok=(n:number)=>Math.round(n/CPT);
const fmt = (t:any)=>`${t.label} (${t.timing})\n${t.format.map((s:string,i:number)=>`  ${i+1}. ${s}`).join("\n")}`;
const nc = EMAIL_TYPES.filter(t=>t.id!=="custom");
const whole = nc.map(fmt).join("\n\n");
const sizes = nc.map(t=>fmt(t).length).sort((a,b)=>a-b);
console.log(`today's 40-format dump inside formatBlock('custom'): ${whole.length} ch / ~${tok(whole.length)} tok  (PLAN-A: 23,527 ch / ~6,359 tok)`);
for(const k of [3,4,6]){
  const med = sizes[Math.floor(sizes.length/2)]*k;
  const worst = sizes.slice(-k).reduce((a,b)=>a+b,0);
  console.log(`  keep ${k} formats: median-sized ${med} ch / ~${tok(med)} tok ; worst-case ${worst} ch / ~${tok(worst)} tok  => delta ~-${tok(whole.length)-tok(med)} tok (median) / -${tok(whole.length)-tok(worst)} tok (worst)`);
}
console.log(`  PLAN-A quotes -5,700 tok (§0 table) and -5,890 tok (§6 body) for the same change.`);
console.log();
console.log("=== #R5 / #0-row-5: cutting cold_email from 9 examples to 4 ===");
const ce=(EMAIL_EXAMPLES as any)["cold_email"];
const block=(es:any[])=>`EXAMPLES - ${es.length} emails of exactly this type (all facts fictional):\n\n`+es.map((e,i)=>`--- Example ${i+1}${e.note?` (${e.note})`:""}\nSubject: ${e.subject}\n\n${e.body}`).join("\n\n");
const full=block(ce).length;
const byLen=[...ce].sort((a,b)=>a.body.length-b.body.length);
console.log(`cold_email examplesBlock, 9 examples: ${full} ch / ~${tok(full)} tok  (PLAN-A: 10,660 ch / ~2,881 tok)`);
console.log(`  keep 4 shortest: ${block(byLen.slice(0,4)).length} ch => saves ~${tok(full)-tok(block(byLen.slice(0,4)).length)} tok`);
console.log(`  keep 4 longest : ${block(byLen.slice(-4)).length} ch => saves ~${tok(full)-tok(block(byLen.slice(-4)).length)} tok`);
console.log(`  PLAN-A §R5 claims "~1,400 input tokens".`);
