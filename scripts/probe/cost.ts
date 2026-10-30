import { OCCASIONS, resolveSituation, situationTypes } from "../../src/lib/draft-occasions";
import { buildDraftPrompt, type DraftPromptInput } from "../../src/lib/draft-prompt";
import { sims } from "../draft-occasions-sim";
const CPT=3.7; const tok=(s:string)=>Math.round(s.length/CPT); const BASE=sims()[0];
const HEAD_END="- Then write the body from the plan, sentence for sentence.";
const TAIL_START="\n\nFINDING COMMON GROUND";
const CEIL=/\nHARD CEILING: \d+ words in the body, signature excluded\. A ceiling, not a target\./;
function tiers(input: DraftPromptInput){
  const s=buildDraftPrompt(input).system;
  const h=s.indexOf(HEAD_END)+HEAD_END.length, t=s.lastIndexOf(TAIL_START);
  const head=s.slice(0,h), tail=s.slice(t+2); let mid=s.slice(h+2,t);
  const cm=mid.match(CEIL); const ceil=cm?cm[0]:""; mid=cm?mid.replace(CEIL,""):mid;
  const ib=mid.indexOf("SEVERAL THINGS ARE TRUE AT ONCE.");
  let blend=""; if(ib>=0){ let e=mid.indexOf("\n\nEXAMPLES",ib); if(e<0)e=mid.indexOf("\n\nCOMBINATION FORMAT",ib); blend=mid.slice(ib, e<0?undefined:e); mid = mid.slice(0,ib-2)+(e<0?"":mid.slice(e)); }
  const ic=mid.indexOf("COMBINATION FORMAT - how the playbook folds");
  let comb=""; if(ic>=0){ comb=mid.slice(ic); mid=mid.slice(0,ic-2); }
  const perRequest=[ceil.trim(),blend,comb].filter(Boolean).join("\n\n");
  return { total: tok(s), invariant: tok(head+"\n\n"+tail), perType: tok(mid), perRequest: tok(perRequest),
           sysChars: s.length, prChars: perRequest.length };
}
console.log("== Is the plan's 'cold_email, 3 boxes' (27,822 ch / 7,519 tok) reachable? ==");
// what the plan most likely built: type=cold_email forced as lead with 2 also-types
const forced = tiers({...BASE.input, type:"cold_email", alsoTypes:["cold_referral","cold_after_meeting"], boxIds:["first.alum","first.referred","first.met"]});
console.log(`forced cold_email+referral+met (alsoTypes set by hand): ${forced.sysChars} ch / ~${forced.total} tok`);
let maxReach=0, maxLabel="";
const rows: {label:string;t:ReturnType<typeof tiers>;n:number;lead:string}[]=[];
function subsets<T>(xs:T[]):T[][]{const o:T[][]=[];for(let m=1;m<1<<xs.length;m++){const s:T[]=[];for(let i=0;i<xs.length;i++)if(m&(1<<i))s.push(xs[i]);o.push(s);}return o;}
for(const occ of OCCASIONS) for(const c of subsets(occ.sections.flatMap(s=>s.boxes.map(b=>b.id)))){
  const r=resolveSituation(occ.id,c); if("error" in r) continue;
  const ty=situationTypes(r);
  const t=tiers({...BASE.input,type:ty[0].id,alsoTypes:ty.slice(1).map(x=>x.id),boxIds:c,situationSummary:r.summary});
  rows.push({label:c.join("+"),t,n:c.length,lead:ty[0].id});
  if(t.sysChars>maxReach && ty[0].id!=="custom"){maxReach=t.sysChars;maxLabel=`${ty[0].id} [${c.join("+")}]`;}
}
console.log(`largest REACHABLE non-custom system prompt: ${maxReach} ch / ~${Math.round(maxReach/CPT)} tok  (${maxLabel})`);
console.log(`combos with lead=cold_email and >1 box: ${rows.filter(r=>r.lead==="cold_email"&&r.n>1).length}`);

console.log("\n== §3 cost table, recomputed on REAL tier sizes (write 1.25x / 1h-write 2x / read 0.1x) ==");
const ce = tiers({...BASE.input,type:"cold_email",alsoTypes:[],boxIds:["first.alum"]});
console.log(`cold_email 1 box: total ${ce.total} | invariant ${ce.invariant} | perType ${ce.perType} | perRequest ${ce.perRequest} (${ce.prChars} ch) | sum ${ce.invariant+ce.perType+ce.perRequest}`);
const f=(x:number)=>Math.round(x);
console.log(`  row1 cold cache : today ${f(ce.total*1.25)} | tiered ${f(ce.invariant*2+ce.perType*2+ce.perRequest*1.25)}  (plan: 6,994 vs 11,172)`);
console.log(`  row2 same, warm : today ${f(ce.total*0.1)} | tiered ${f((ce.invariant+ce.perType)*0.1+ce.perRequest*1.25)}  (plan: 560 vs 559)`);
console.log(`  row3 diff type, invariant warm: today ${f(ce.total*1.25)} | tiered ${f(ce.invariant*0.1+ce.perType*2+ce.perRequest*1.25)}  (plan: 6,994 vs 6,447)`);
console.log(`  row4 diff type, both warm: today ${f(ce.total*1.25)} | tiered ${f((ce.invariant+ce.perType)*0.1+ce.perRequest*1.25)}  (plan: 6,994 vs 559 = -92%)`);
// row 5 "same type, different mix" on the real worst reachable multi-box
const big = rows.filter(r=>r.lead!=="custom").sort((a,b)=>b.t.sysChars-a.t.sysChars)[0];
console.log(`  row5 same type, different mix -- plan used an UNREACHABLE 7,519-tok prompt.`);
console.log(`       largest reachable mix: ${big.lead} [${big.label}] total ${big.t.total} | invariant ${big.t.invariant} | perType ${big.t.perType} | perRequest ${big.t.perRequest}`);
const t5today=big.t.total*1.25, t5tier=(big.t.invariant+big.t.perType)*0.1+big.t.perRequest*1.25;
console.log(`       today ${f(t5today)} | tiered ${f(t5tier)} => ${((t5tier/t5today-1)*100).toFixed(0)}%   (plan claimed -68% from 9,399 -> 2,964)`);
// median reachable multi-box
const multi = rows.filter(r=>r.n>1&&r.lead!=="custom").sort((a,b)=>a.t.total-b.t.total);
const m = multi[Math.floor(multi.length/2)];
const mToday=m.t.total*1.25, mTier=(m.t.invariant+m.t.perType)*0.1+m.t.perRequest*1.25;
console.log(`       median reachable mix (${m.lead} [${m.label}]): today ${f(mToday)} | tiered ${f(mTier)} => ${((mTier/mToday-1)*100).toFixed(0)}%`);
// Across all 107, warm-tier steady state vs today's cold write
let st=0, sy=0; for(const r of rows){ st+=(r.t.invariant+r.t.perType)*0.1+r.t.perRequest*1.25; sy+=r.t.total*1.25; }
console.log(`\n  ALL 107 combos, both tiers warm: tiered ${f(st/rows.length)} vs today cold ${f(sy/rows.length)} per draft => ${((st/sy-1)*100).toFixed(0)}%  (plan headline: -40% to -68%)`);
// and vs today WARM (the fair comparison when the same combo repeats)
let sw=0; for(const r of rows) sw+=r.t.total*0.1;
console.log(`  ALL 107, today WARM (same combo repeats): ${f(sw/rows.length)} per draft => tiered is ${((st/sw-1)*100).toFixed(0)}% vs that`);
console.log(`\n  combos whose perRequest is EMPTY (an empty text block is not a valid API content block): ${rows.filter(r=>r.t.prChars===0).length}`);
for(const r of rows.filter(x=>x.t.prChars===0)) console.log(`     ${r.lead} [${r.label}]`);
