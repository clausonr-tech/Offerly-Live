// Scratch (OUTPUT-1 audit): repetition across emails — sentences, openings, closers, n-grams.
import { readFileSync } from "node:fs";
const recs = [];
for (const f of process.argv.slice(2)) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  for (const r of j.scenarios ?? j.records ?? []) if (r.ok) recs.push(r);
}
const bodyOf = (r) => (r.body ?? "");
const lines = (r) => bodyOf(r).split("\n").map(s=>s.trim()).filter(Boolean);
const sentences = (t) => t.replace(/\n+/g," ").split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(s=>s.split(/\s+/).length>=4);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9' ]/g," ").replace(/\s+/g," ").trim();

console.log(`emails: ${recs.length}`);

// 1. identical sentences across scenarios
const bySent = new Map();
for (const r of recs) for (const s of sentences(bodyOf(r))) {
  const k = norm(s); if (!k) continue;
  if (!bySent.has(k)) bySent.set(k, []);
  bySent.get(k).push(`${r.id}/${r.profile}`);
}
console.log("\n=== identical sentences in >1 email ===");
for (const [k,ids] of [...bySent].filter(([,v])=>new Set(v).size>1).sort((a,b)=>b[1].length-a[1].length)) console.log(`${ids.length}x  "${k}"  [${[...new Set(ids)].join(", ")}]`);

// 2. first sentence of each email (opening formula)
console.log("\n=== first sentence after greeting ===");
for (const r of recs) {
  const ls = lines(r);
  const first = ls[1] ?? "";
  console.log(`${r.id}/${r.profile}: ${sentences(first)[0] ?? first}`);
}

// 3. opening 4-word shapes
const shape = new Map();
for (const r of recs) {
  const ls = lines(r); const first = sentences(ls[1] ?? "")[0] ?? ls[1] ?? "";
  const k = norm(first).split(" ").slice(0,4).join(" ");
  if (!shape.has(k)) shape.set(k, []); shape.get(k).push(`${r.id}/${r.profile}`);
}
console.log("\n=== opening 4-word shapes used by >1 email ===");
for (const [k,v] of [...shape].filter(([,v])=>v.length>1).sort((a,b)=>b[1].length-a[1].length)) console.log(`${v.length}x "${k}..." [${v.join(", ")}]`);

// 4. last sentence before sign-off
console.log("\n=== closing sentence before Best, ===");
const closers = new Map();
for (const r of recs) {
  const ls = lines(r); const i = ls.findIndex(l=>/^Best,?$/i.test(l));
  const before = i>0 ? ls.slice(0,i) : ls;
  const ss = sentences(before.join(" "));
  const last = ss[ss.length-1] ?? "";
  console.log(`${r.id}/${r.profile}: ${last}`);
  const k = norm(last); if(!closers.has(k)) closers.set(k,[]); closers.get(k).push(r.id);
}
console.log("\n=== repeated closing sentences ===");
for (const [k,v] of [...closers].filter(([,v])=>v.length>1)) console.log(`${v.length}x "${k}" [${v.join(", ")}]`);

// 5. recurring 5-grams across emails
const grams = new Map();
for (const r of recs) {
  const w = norm(bodyOf(r)).split(" ");
  const seen = new Set();
  for (let i=0;i+5<=w.length;i++){ const g=w.slice(i,i+5).join(" "); if(seen.has(g))continue; seen.add(g);
    if(!grams.has(g))grams.set(g,new Set()); grams.get(g).add(`${r.id}`);}
}
console.log("\n=== 5-grams appearing in >=3 different emails ===");
for (const [g,ids] of [...grams].filter(([,s])=>s.size>=3).sort((a,b)=>b[1].size-a[1].size).slice(0,60)) console.log(`${ids.size}x "${g}"`);

// 6. contraction inventory
console.log("\n=== contractions per email (final) ===");
const cre = /\b(?:I'm|I'd|I'll|I've|don't|doesn't|didn't|it's|that's|can't|won't|isn't|aren't|wasn't|haven't|hasn't|you're|we're|they're|there's|here's|what's|let's|couldn't|wouldn't|shouldn't|she's|he's|I'd've|who's)\b/gi;
for (const r of recs) {
  const m = bodyOf(r).match(cre) ?? [];
  const mp = (r.preReviewBody??"").match(cre) ?? [];
  console.log(`${r.id}/${r.profile}: pre[${mp.join(", ")}] -> post[${m.join(", ")}]`);
}
