// CORPUS-VARIETY gate: applies VARIETY_EDITS in memory and asserts the five
// things that decide whether they are safe, plus the variety table they exist
// to move. READ-ONLY on src/ - nothing is written.
//
//   npx tsx scripts/audit-probe/corpus/variety-check.ts
//   npx tsx scripts/audit-probe/corpus/variety-check.ts --diff
//
// The five gates, in the order a failure matters:
//   1. every `find` occurs EXACTLY ONCE in its resolved body
//   2. no fact token lost in any touched body
//   3. no body over its type's maxWords ceiling (words may go UP)
//   4. ASK reaches exactly the same bodies before and after (115/192)
//   5. no check gains a finding: fluencyIssues AND commaSplices
//      (commaSplices is in `draftChecks`, which is what the 138-edit pass's
//      own gate could not see - CORPUS-APPLIED section 4)
// and two that police the variety itself:
//   6. no replacement's sentence duplicates any sentence, or any sentence
//      SHAPE, already in the corpus - a new cliche is the failure being fixed
//   7. no replacement newly matches CANNED_LINES - the banned prose stays gone

import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";
import { EMAIL_TYPES } from "../../../src/lib/draft-templates";
import { fluencyIssues, commaSplices, ASK } from "../../../src/lib/draft-lint";
import { VARIETY_EDITS } from "./edits-variety";
import { mainText, skeleton } from "./variety";

const CANNED: Record<string, RegExp[]> = {
  resumeLine: [
    /\bresume\b[^.!?]{0,40}\bfor your (?:reference|review|convenience|consideration)\b/i,
    /\bfor your (?:reference|review|convenience)\b[^.!?]{0,40}\bresume\b/i,
    /\bI(?:'ve| have| )?\s*attached (?:a copy of )?my resume\b/i,
    /\bmy resume(?:'s| is) attached\b/i,
    /\bplease (?:find|see)[^.!?]{0,20}\battached\b/i,
  ],
  flexibilityLine: [
    /\b(?:more than )?(?:happy|glad) to work around your schedule\b/i,
    /\bat your (?:earliest )?convenience\b/i,
    /\bwhatever (?:time |day |day or time )?works best for you\b/i,
    /\bwhenever (?:is |works )(?:most )?convenient\b/i,
    /\bI(?:'m| am) flexible (?:on|with|around) (?:timing|time|your schedule|whatever)\b/i,
    /\bany time that suits you works for me\b/i,
  ],
  easyOutLine: [
    /\bno (?:worries|pressure|problem)\b[^.!?]{0,40}\bif\b/i,
    /\bI (?:completely |totally |of course )?understand if\b/i,
    /\bif you(?:'re| are) (?:too )?busy\b/i,
    /\bno need to (?:reply|respond|apologi[sz]e)\b/i,
    /\bif (?:now|the timing)[^.!?]{0,25}\b(?:isn't|is not|doesn't|does not)\b/i,
  ],
};

const sentencesOf = (t: string) =>
  t.replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"])/).map((s) => s.trim()).filter(Boolean);
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const ceiling = new Map<string, number>(EMAIL_TYPES.map((t) => [t.id as string, (t as { maxWords?: number }).maxWords ?? 9999]));

function factTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![.!?]\s|^)\b([A-Z][a-zA-Z’'&.-]{1,})\b/gm)) out.push(m[1]);
  for (const m of text.matchAll(/\b(\d[\d,./–-]*)\b/g)) out.push(m[1]);
  for (const m of text.matchAll(/(’\d\d)\b/g)) out.push(m[1]);
  return out;
}

/**
 * The sentences an edit ADDS. Several rows keep their find's sentence and
 * append one after it ("I attached my resume. <new sentence>"), so judging the
 * whole replacement would flag text that was already there and unchanged.
 */
function addedSentences(e: { find: string; replace: string }): string[] {
  const had = new Set(sentencesOf(e.find).map(norm));
  return sentencesOf(e.replace).filter((s) => !had.has(norm(s)));
}

type Body = { key: string; typeId: string; original: string; edited: string };
const bodies: Body[] = [];
for (const [typeId, examples] of Object.entries(EMAIL_EXAMPLES as Record<string, { body: string }[]>)) {
  examples.forEach((e, i) => bodies.push({ key: `${typeId}#${i + 1}`, typeId, original: e.body, edited: e.body }));
}
const byKey = new Map(bodies.map((b) => [b.key, b]));

let fatal = 0;
const touched = new Set<string>();

// ---- 1. resolve and apply -------------------------------------------------
for (const [n, ed] of VARIETY_EDITS.entries()) {
  const b = byKey.get(ed.key);
  if (!b) { console.log(`FATAL edit ${n + 1} (${ed.key}): no such body`); fatal++; continue; }
  const hits = b.edited.split(ed.find).length - 1;
  if (hits !== 1) {
    console.log(`FATAL edit ${n + 1} (${ed.key}) [${ed.shape}]: find occurs ${hits}x, need exactly 1`);
    console.log(`      find: ${JSON.stringify(ed.find.slice(0, 100))}`);
    fatal++; continue;
  }
  b.edited = b.edited.replace(ed.find, ed.replace);
  touched.add(ed.key);
}
console.log(`\n===== APPLY =====`);
console.log(`  ${VARIETY_EDITS.length} edits over ${touched.size} bodies` + (fatal ? `  (${fatal} FATAL)` : "  all finds unique"));

// ---- shapes must not repeat across rows -----------------------------------
{
  const s = new Map<string, number>();
  for (const e of VARIETY_EDITS) s.set(e.shape, (s.get(e.shape) ?? 0) + 1);
  const dup = [...s].filter(([, n]) => n > 1);
  console.log(dup.length ? `  REPEATED SHAPE NAMES: ${dup.map(([k, n]) => `${k} x${n}`).join(", ")}` : `  ${s.size} distinct construction names, none repeated`);
  if (dup.length) fatal++;
}

// ---- 2. fact fidelity -----------------------------------------------------
console.log(`\n===== FACT FIDELITY (${touched.size} bodies touched) =====`);
let factFails = 0;
for (const b of bodies) {
  if (!touched.has(b.key)) continue;
  const before = factTokens(mainText(b.original));
  const after = mainText(b.edited);
  const lost = [...new Set(before)].filter((t) => !after.includes(t));
  if (lost.length) { console.log(`  ${b.key}: LOST ${lost.join(", ")}`); factFails++; }
}
console.log(`  ${factFails} of ${touched.size} lose a fact token`);
if (factFails) fatal++;

// ---- 3. length ------------------------------------------------------------
console.log(`\n===== LENGTH =====`);
let over = 0, delta = 0;
for (const b of bodies) {
  if (!touched.has(b.key)) continue;
  const w0 = words(mainText(b.original)), w1 = words(mainText(b.edited));
  delta += w1 - w0;
  const cap = ceiling.get(b.typeId)!;
  if (w1 > cap) { console.log(`  ${b.key}: ${w1}w OVER ceiling ${cap}`); over++; }
  if (process.argv.includes("--diff")) console.log(`  ${b.key.padEnd(28)} ${w0} -> ${w1} (${w1 - w0 >= 0 ? "+" : ""}${w1 - w0}) / ${cap}`);
}
console.log(`  net word delta: ${delta >= 0 ? "+" : ""}${delta}`);
console.log(over ? `  ${over} bodies OVER their ceiling` : "  no body over its type ceiling");
if (over) fatal++;

// ---- 4. the ask -----------------------------------------------------------
console.log(`\n===== THE ASK =====`);
{
  const before = bodies.filter((b) => ASK.test(b.original)).length;
  const after = bodies.filter((b) => ASK.test(b.edited)).length;
  const lost = bodies.filter((b) => ASK.test(b.original) && !ASK.test(b.edited)).map((b) => b.key);
  const gained = bodies.filter((b) => !ASK.test(b.original) && ASK.test(b.edited)).map((b) => b.key);
  console.log(`  ASK reaches ${before}/192 before, ${after}/192 after`);
  if (lost.length) console.log(`  LOST THE ASK: ${lost.join(", ")}`);
  if (gained.length) console.log(`  GAINED AN ASK (also a change): ${gained.join(", ")}`);
  if (lost.length || gained.length) fatal++;
  else console.log(`  no body changed ask status`);
}

// ---- 5. no check gains a finding ------------------------------------------
console.log(`\n===== CHECKS (fluencyIssues + commaSplices) =====`);
for (const [name, run] of [
  ["fluencyIssues", (t: string) => fluencyIssues(t, null)],
  ["commaSplices", (t: string) => commaSplices(t)],
] as [string, (t: string) => string[]][]) {
  const per = (f: (b: Body) => string) => {
    const out: string[] = [];
    let n = 0;
    for (const b of bodies) { const is = run(mainText(f(b))); if (is.length) { n += is.length; out.push(`${b.key}: ${is.join(" | ")}`); } }
    return { n, out };
  };
  const a = per((b) => b.original), c = per((b) => b.edited);
  const neu = c.out.filter((x) => !a.out.includes(x));
  const gone = a.out.filter((x) => !c.out.includes(x));
  console.log(`  ${name.padEnd(14)} ${a.n} -> ${c.n}  (${c.n - a.n >= 0 ? "+" : ""}${c.n - a.n})`);
  for (const x of neu) console.log(`    NEW  ${x}`);
  for (const x of gone) console.log(`    GONE ${x}`);
  if (neu.length) fatal++;
}

// ---- 6. no replacement repeats a sentence or a sentence SHAPE -------------
console.log(`\n===== NEW SENTENCES MUST BE NEW =====`);
{
  // Every sentence in the corpus AFTER the edits, with its owners.
  const owners = new Map<string, Set<string>>();
  const shapeOwners = new Map<string, Set<string>>();
  for (const b of bodies) for (const s of sentencesOf(mainText(b.edited))) {
    const k = norm(s); if (!k) continue;
    if (!owners.has(k)) owners.set(k, new Set()); owners.get(k)!.add(b.key);
    const sk = skeleton(s);
    if (sk.split(" ").length >= 4) { if (!shapeOwners.has(sk)) shapeOwners.set(sk, new Set()); shapeOwners.get(sk)!.add(b.key); }
  }
  let collide = 0;
  for (const e of VARIETY_EDITS) {
    for (const s of addedSentences(e)) {
      const k = norm(s);
      const who = owners.get(k);
      if (who && who.size > 1) { console.log(`  DUPLICATE SENTENCE  ${e.key}: ${JSON.stringify(s.slice(0, 60))} also in ${[...who].filter((x) => x !== e.key).join(", ")}`); collide++; }
      const sk = skeleton(s);
      const whoS = shapeOwners.get(sk);
      if (sk.split(" ").length >= 4 && whoS && whoS.size > 1) { console.log(`  DUPLICATE SHAPE     ${e.key}: ${JSON.stringify(s.slice(0, 60))} shares a shape with ${[...whoS].filter((x) => x !== e.key).join(", ")}`); collide++; }
    }
  }
  console.log(collide ? `  ${collide} collisions` : `  no replacement duplicates an existing sentence or shape`);
  if (collide) fatal++;
}

// ---- 7. the banned prose stays gone ---------------------------------------
console.log(`\n===== CANNED_LINES =====`);
{
  let newly = 0;
  for (const e of VARIETY_EDITS) {
    const added = addedSentences(e).join(" ");
    for (const [fam, res] of Object.entries(CANNED)) {
      const hit = res.find((r) => r.test(added));
      if (hit) { console.log(`  ${e.key}: replacement matches CANNED.${fam}  ${hit}`); newly++; }
    }
  }
  const famCount = (f: (b: Body) => string, fam: string) => bodies.filter((b) => CANNED[fam].some((r) => r.test(mainText(f(b))))).length;
  for (const fam of Object.keys(CANNED)) console.log(`  bodies with ${fam.padEnd(16)} ${famCount((b) => b.original, fam)} -> ${famCount((b) => b.edited, fam)}`);
  console.log(newly ? `  ${newly} replacements reintroduce banned prose` : `  no replacement reintroduces banned prose`);
  if (newly) fatal++;
}

// ---- the variety table ----------------------------------------------------
function varietyOf(f: (b: Body) => string) {
  const texts = bodies.map((b) => mainText(f(b)));
  const sents = texts.map(sentencesOf);
  const owners = new Map<string, Set<number>>();
  sents.forEach((ss, i) => { for (const s of ss) { const k = norm(s); if (!k || k.split(" ").length < 5) continue; if (!owners.has(k)) owners.set(k, new Set()); owners.get(k)!.add(i); } });
  const skel = new Map<string, Set<number>>();
  sents.forEach((ss, i) => { for (const s of ss) { const k = skeleton(s); if (k.split(" ").length < 4) continue; if (!skel.has(k)) skel.set(k, new Set()); skel.get(k)!.add(i); } });
  const reuse = [...skel.values()].reduce((a, s) => a + (s.size > 1 ? s.size : 0), 0);
  const total = [...skel.values()].reduce((a, s) => a + s.size, 0);
  const openers = sents.map((s) => s[0] ?? ""), closers = sents.map((s) => s[s.length - 1] ?? "");
  const t = <T,>(xs: T[]) => { const m = new Map<T, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return m; };
  const topOf = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0];
  return {
    words: texts.reduce((a, x) => a + words(x), 0),
    repeatedSentences: [...owners.values()].filter((s) => s.size > 1).length,
    skelReuse: +(reuse / total).toFixed(4),
    distinctOpeners: new Set(openers).size,
    distinctClosers: new Set(closers).size,
    topOpener: topOf(t(openers)),
    topCloser: topOf(t(closers)),
    thanksClose: closers.filter((c) => /^thank(?:s| you)\b/i.test(c)).length,
    thanksTime: closers.filter((c) => /^thank(?:s| you)\b[^.!?]*\bfor (?:your |the |taking the )?time\b/i.test(c)).length,
  };
}
const A = varietyOf((b) => b.original), B = varietyOf((b) => b.edited);
console.log(`\n===== VARIETY (all 192 gold bodies) =====\n`);
const row = (n: string, a: unknown, b: unknown) => console.log(`  ${n.padEnd(38)} ${String(a).padStart(10)} -> ${String(b).padStart(10)}`);
row("total body words", A.words, B.words);
row("repeated sentences (harness def)", A.repeatedSentences, B.repeatedSentences);
row("sentence-shape reuse rate", A.skelReuse, B.skelReuse);
row("distinct openers", A.distinctOpeners, B.distinctOpeners);
row("distinct closers", A.distinctClosers, B.distinctClosers);
row("most-repeated opener", `${A.topOpener[1]}x`, `${B.topOpener[1]}x`);
row("most-repeated closer", `${A.topCloser[1]}x`, `${B.topCloser[1]}x`);
row("closes on a thanks", A.thanksClose, B.thanksClose);
row("closes on thanks-for-time", A.thanksTime, B.thanksTime);
console.log(`\n  closer after: ${B.topCloser[1]}x ${JSON.stringify(B.topCloser[0].slice(0, 50))}`);

console.log(fatal ? `\n${fatal} FATAL - do not apply.\n` : `\nAll gates pass.\n`);
process.exitCode = fatal ? 1 : 0;
