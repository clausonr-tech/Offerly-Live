// TESTER-1: Claim #2 arithmetic. Whole-body re-emission vs an edits[] payload,
// over the two real fixture corpora. Offline, no API.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const FIX = join(fileURLToPath(new URL(".", import.meta.url)), "..", "draft-fixtures");
const CPT = 3.7; const tok = (s: string) => s.length / CPT;

type Draft = { subject: string; body: string };
function parse(file: string): Map<string, Draft> {
  const parts = readFileSync(file, "utf8").split(/^=== (\d+)\s*$/m).slice(1);
  const out = new Map<string, Draft>();
  for (let i = 0; i < parts.length; i += 2) {
    const [sub, ...rest] = parts[i+1].replace(/^\n/, "").split("\n");
    if (rest[0]?.startsWith("Notes:")) rest.shift();
    out.set(parts[i], { subject: sub.replace(/^Subject:\s*/, ""), body: rest.join("\n").trim() });
  }
  return out;
}
// The reviewer never touches the greeting line or anything at/after "Best,"
// (today by guard, under PLAN-A #2 by construction). So only the middle is editable.
function editable(body: string): string {
  const lines = body.split("\n");
  const close = lines.findIndex((l) => /^\s*(Best|Thanks|Thank you|Sincerely|Warmly)[,.]?\s*$/i.test(l));
  return lines.slice(1, close < 0 ? lines.length : close).join("\n").trim();
}
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(s=>s.length>1);
}

for (const [name, file] of [["occasion-drafts (87)","occasion-drafts.txt"],["scenario-drafts (474)","scenario-drafts-474.txt"]] as const) {
  const drafts = [...parse(join(FIX, file)).values()];
  const stats = drafts.map((d) => {
    const ed = editable(d.body);
    const ss = sentences(ed);
    return { bodyTok: tok(d.body), edTok: tok(ed), n: ss.length, meanSentTok: ss.length ? tok(ed)/ss.length : 0, ss };
  });
  const med = (xs: number[]) => { const s=[...xs].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; };
  console.log(`\n==== ${name} : n=${drafts.length} ====`);
  console.log(`body tokens (what the reviewer re-emits today): median ${med(stats.map(s=>s.bodyTok)).toFixed(0)}, mean ${(stats.reduce((a,s)=>a+s.bodyTok,0)/stats.length).toFixed(0)}`);
  console.log(`editable middle: median ${med(stats.map(s=>s.edTok)).toFixed(0)} tok, median ${med(stats.map(s=>s.n))} sentences, median sentence ${med(stats.map(s=>s.meanSentTok)).toFixed(1)} tok`);

  // JSON scaffolding cost, measured not guessed: serialise real payloads.
  console.log(`\n  k = number of sentences the reviewer rewrites`);
  console.log(`  k | edits[] output tok | whole-body output tok | saving`);
  for (const k of [1,2,3,4,5]) {
    let a = 0, b = 0;
    for (const s of stats) {
      const picks = s.ss.slice(0, Math.min(k, s.ss.length));
      // (b) today: the reviewer emits subject + the complete body
      const whole = JSON.stringify({ subject: "x".repeat(50), body: "x" }).length - 1 + 0;
      b += tok(JSON.stringify({ subject: "A subject line of ordinary length", body: s.ss.join(" ") }));
      // (a) PLAN-A #2: subjectFix + one {find,replace} per rewritten sentence.
      // `replace` is the SAME sentence rewritten -> same length (the guard caps growth at +15%).
      a += tok(JSON.stringify({ subjectFix: null, edits: picks.map((p) => ({ find: p, replace: p })) }));
    }
    const sav = (1 - a/b) * 100;
    console.log(`  ${k} | ${(a/stats.length).toFixed(0)} | ${(b/stats.length).toFixed(0)} | ${sav >= 0 ? "-" : "+"}${Math.abs(sav).toFixed(0)}%  ${sav < 40 ? "  << below the plan's 40% floor" : ""}`);
  }
  // break-even k
  for (const s of [stats]) {
    let be = 0;
    for (let k=1;k<=12;k++){ let a=0,b=0; for(const st of stats){const p=st.ss.slice(0,Math.min(k,st.ss.length)); a+=tok(JSON.stringify({subjectFix:null,edits:p.map(x=>({find:x,replace:x}))})); b+=tok(JSON.stringify({subject:"A subject line of ordinary length",body:st.ss.join(" ")}));} if(a>=b){be=k;break;} }
    console.log(`  break-even: edits[] costs MORE than the whole body from k = ${be||">12"} rewritten sentences`);
  }
  // and with `problems[]` counted (emitted by BOTH schemas, and it already quotes the span verbatim)
  console.log(`\n  the same, counting problems[] (present in BOTH schemas; its 'quote' already repeats the span verbatim):`);
  for (const k of [1,2,3]) {
    let a=0,b=0;
    for(const st of stats){
      const p = st.ss.slice(0, Math.min(k, st.ss.length));
      const probs = p.map(x=>({kind:"flow",quote:x,fix:"reworded it",needsStudent:false}));
      a += tok(JSON.stringify({problems:probs, subjectFix:null, edits:p.map(x=>({find:x,replace:x}))}));
      b += tok(JSON.stringify({problems:probs, subject:"A subject line of ordinary length", body:st.ss.join(" ")}));
    }
    const sav=(1-a/b)*100;
    console.log(`  k=${k}: edits ${(a/stats.length).toFixed(0)} tok vs whole ${(b/stats.length).toFixed(0)} tok => ${sav>=0?"-":"+"}${Math.abs(sav).toFixed(0)}%`);
  }
}
