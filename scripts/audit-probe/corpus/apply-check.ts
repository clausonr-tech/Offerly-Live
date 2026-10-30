// CORPUS-PLAN probe 3: apply the edit table IN MEMORY and check it.
//
// READ-ONLY on src/. Nothing is written to disk. It answers the four
// questions that decide whether the plan is safe to apply verbatim:
//
//   1. Does every `find` occur exactly once in its body?
//   2. Did any FACT change? Every capitalised token, number, class year and
//      proper noun in the original must still be present afterwards.
//   3. Did length move materially, and is every body still under its
//      type's maxWords ceiling?
//   4. Did fluencyIssues gain a finding anywhere?
//
// Plus the before/after metric table the plan is thresholded on.
//
//   npx tsx scripts/audit-probe/corpus/apply-check.ts
//   npx tsx scripts/audit-probe/corpus/apply-check.ts --diff   # show each body
//   npx tsx scripts/audit-probe/corpus/apply-check.ts --post   # AFTER applying
//
// --post runs the identical gate on what is actually on disk: it reads the
// pre-edit corpus out of `git show HEAD:...` instead of applying EDITS, so
// "original" is the committed body and "edited" is the working-tree body. Use
// it once apply.ts --write has run - the `find` strings are consumed by then,
// so the default mode can only report 138 missing finds.

import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";
import { EMAIL_TYPES } from "../../../src/lib/draft-templates";
import { fluencyIssues, ASK } from "../../../src/lib/draft-lint";
import { EDITS as PLAN_EDITS } from "./edits";
import { VARIETY_EDITS } from "./edits-variety";
import { bodyMap, type JsonVolume } from "./corpus-map";
import { execFileSync } from "node:child_process";

const CONTRACTION =
  /\b(?:I|you|we|they|he|she|it|that|there|here|what|who|how|let|this|y'all)['’](?:m|re|ve|ll|d|s)\b|\b\w+n['’]t\b/gi;
const CANNED = {
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
const PLEASANTRY =
  /^(?:[^.!?]{0,40}\b)?(?:I hope (?:this|you|your|all|things)|hope (?:you|this|all|your|things)|I trust you|how are you|hope all is well)\b/i;
const sentencesOf = (t: string) =>
  t.replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"])/).map((s) => s.trim()).filter(Boolean);
function main(b: string) {
  const l = b.split("\n");
  const s = l.map((x) => x.trim()).lastIndexOf("Best,");
  const a = (s >= 0 ? l.slice(0, s) : l).join("\n").trim();
  return a.split("\n").slice(1).join("\n").trim();
}
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const ceiling = new Map<string, number>(EMAIL_TYPES.map((t) => [t.id as string, (t as { maxWords?: number }).maxWords ?? 9999]));

/**
 * The fact tokens an edit must preserve: proper nouns, numbers, requisition
 * numbers, class years, dates. Deliberately over-inclusive - a false alarm
 * costs a glance, a missed fact change costs the corpus's whole purpose.
 */
function factTokens(text: string): string[] {
  const out: string[] = [];
  // Proper nouns and mid-sentence capitals, excluding sentence-initial words.
  for (const m of text.matchAll(/(?<![.!?]\s|^)\b([A-Z][a-zA-Z’'&.-]{1,})\b/gm)) out.push(m[1]);
  for (const m of text.matchAll(/\b(\d[\d,./–-]*)\b/g)) out.push(m[1]);
  for (const m of text.matchAll(/(’\d\d)\b/g)) out.push(m[1]);
  return out;
}

type Body = { key: string; typeId: string; original: string; edited: string };
const bodies: Body[] = [];
for (const [typeId, examples] of Object.entries(EMAIL_EXAMPLES as Record<string, { body: string }[]>)) {
  examples.forEach((e, i) => bodies.push({ key: `${typeId}#${i + 1}`, typeId, original: e.body, edited: e.body }));
}
const byKey = new Map(bodies.map((b) => [b.key, b]));

// ---- 1. establish original vs edited --------------------------------------
const POST = process.argv.includes("--post");
// Which edit table --post should expect on disk. The plan's 138 are committed
// at 36aecc6, so comparing the working tree against HEAD finds CORPUS-VARIETY's
// 57 instead; --table=variety tells --post that is what it should see.
const TABLE = process.argv.includes("--table=variety") ? "variety" : "plan";
const EDITS: { key: string; find: string; replace: string; shape: string }[] =
  TABLE === "variety" ? VARIETY_EDITS : PLAN_EDITS;
let fatal = 0;
const touched = new Set<string>();

if (POST) {
  // The committed corpus is the "before". No EDITS are applied; the working
  // tree is taken as given and compared against HEAD.
  const show = (f: string) => execFileSync("git", ["show", `HEAD:src/lib/${f}`], { encoding: "utf8", maxBuffer: 64e6 });
  const head = bodyMap(
    show("email-examples.ts"),
    JSON.parse(show("email-examples-v3.json")) as JsonVolume,
    JSON.parse(show("email-examples-v4.json")) as JsonVolume,
    Object.keys(EMAIL_EXAMPLES),
  );
  for (const b of bodies) {
    const was = head.get(b.key);
    if (was === undefined) { console.log(`FATAL ${b.key}: absent from HEAD`); fatal++; continue; }
    b.original = was;
    if (was !== b.edited) touched.add(b.key);
  }
  const want = new Set(EDITS.map((e) => e.key));
  const unexpected = [...touched].filter((k) => !want.has(k));
  const unchanged = [...want].filter((k) => !touched.has(k));
  console.log(`\n===== POST-APPLY (working tree vs HEAD) =====`);
  console.log(`  ${touched.size} bodies differ from HEAD; the ${TABLE} table names ${want.size}`);
  if (unexpected.length) { console.log(`  CHANGED BUT NOT IN THE TABLE: ${unexpected.join(", ")}`); fatal++; }
  if (unchanged.length) { console.log(`  IN THE TABLE BUT UNCHANGED: ${unchanged.join(", ")}`); fatal++; }
  if (!unexpected.length && !unchanged.length) console.log(`  the changed set is exactly the ${TABLE} table's ${want.size} bodies`);
  // Every replacement should now be present, and no `find` should survive.
  // An APPEND-style row keeps its find's text and adds a sentence after it
  // ("I attached my resume." -> "I attached my resume. <new sentence>"), so for
  // those the find SHOULD still be on disk - exactly once. Requiring it to be
  // gone would report a pass as a failure. Every other row must consume it.
  const appends = EDITS.filter((e) => e.replace.includes(e.find));
  const badAppend = appends.filter((e) => (byKey.get(e.key)?.edited.split(e.find).length ?? 1) - 1 !== 1);
  const leftover = EDITS.filter((e) => !e.replace.includes(e.find) && byKey.get(e.key)?.edited.includes(e.find));
  if (appends.length) console.log(`  ${appends.length} rows append rather than replace; their find text is kept by design` + (badAppend.length ? `, but ${badAppend.map((e) => e.key).join(", ")} no longer hold it exactly once` : `, each still present exactly once`));
  if (badAppend.length) fatal++;
  const missing = EDITS.filter((e) => e.replace.trim() && !byKey.get(e.key)?.edited.includes(e.replace.trim()));
  console.log(leftover.length ? `  ${leftover.length} edits still have their original text on disk: ${leftover.map((e) => e.key).join(", ")}` : `  no edit's original text survives on disk`);
  console.log(missing.length ? `  ${missing.length} replacements NOT found on disk: ${missing.map((e) => e.key).join(", ")}` : `  every non-empty replacement is present on disk`);
  if (leftover.length || missing.length) fatal++;
} else {
  for (const [n, ed] of EDITS.entries()) {
    const b = byKey.get(ed.key);
    if (!b) {
      console.log(`FATAL edit ${n} (${ed.key}): no such body`);
      fatal++;
      continue;
    }
    const hits = b.edited.split(ed.find).length - 1;
    if (hits !== 1) {
      console.log(`FATAL edit ${n} (${ed.key}) [${ed.shape}]: find occurs ${hits}x, need exactly 1`);
      console.log(`      find: ${JSON.stringify(ed.find.slice(0, 90))}`);
      fatal++;
      continue;
    }
    b.edited = b.edited.replace(ed.find, ed.replace);
    touched.add(ed.key);
  }
}
if (fatal) {
  console.log(`\n${fatal} FATAL failures - read nothing below as a pass.\n`);
  process.exitCode = 1;
}

// ---- 2. fact fidelity ------------------------------------------------------
console.log(`\n===== FACT FIDELITY (${touched.size} bodies touched) =====`);
let factFails = 0;
for (const b of bodies) {
  if (!touched.has(b.key)) continue;
  const before = factTokens(main(b.original));
  const after = main(b.edited);
  const lost = [...new Set(before)].filter((t) => !after.includes(t));
  if (lost.length) {
    console.log(`  ${b.key}: LOST ${lost.join(", ")}`);
    factFails++;
  }
}
console.log(factFails ? `  ${factFails} bodies lost a fact token` : "  no fact token lost in any touched body");

// ---- 3. length + ceiling ---------------------------------------------------
console.log(`\n===== LENGTH =====`);
let overCeiling = 0;
let deltaSum = 0;
for (const b of bodies) {
  if (!touched.has(b.key)) continue;
  const w0 = words(main(b.original));
  const w1 = words(main(b.edited));
  deltaSum += w1 - w0;
  const cap = ceiling.get(b.typeId)!;
  if (w1 > cap) {
    console.log(`  ${b.key}: ${w1}w OVER ceiling ${cap}`);
    overCeiling++;
  }
  if (process.argv.includes("--diff")) console.log(`  ${b.key.padEnd(26)} ${w0} -> ${w1} (${w1 - w0 >= 0 ? "+" : ""}${w1 - w0}) / ${cap}`);
}
console.log(`  net word delta across touched bodies: ${deltaSum >= 0 ? "+" : ""}${deltaSum}`);
console.log(overCeiling ? `  ${overCeiling} bodies OVER their ceiling` : "  no body over its type ceiling");

// ---- 3b. the ask must survive -----------------------------------------------
// Found the hard way: rewriting recruiting_inbox's "I wanted to ask whether X"
// into a bare interrogative ("Is eligibility based on X?") deletes the ASK
// regex's only match, which switches off everything downstream that reads the
// ask - including the guard's "the edit dropped the request" check. The email
// still asks; draft-lint can no longer tell. Every replacement that touches an
// ask must keep one of ASK's families.
console.log(`\n===== THE ASK (draft-lint ASK) =====`);
{
  const before = bodies.filter((b) => ASK.test(b.original)).length;
  const after = bodies.filter((b) => ASK.test(b.edited)).length;
  const lost = bodies.filter((b) => ASK.test(b.original) && !ASK.test(b.edited)).map((b) => b.key);
  console.log(`  ASK reaches ${before}/192 before, ${after}/192 after`);
  console.log(lost.length ? `  LOST THE ASK: ${lost.join(", ")}` : "  no body lost its ask");
  if (lost.length) process.exitCode = 1;
}

// ---- 4. fluency findings ---------------------------------------------------
const fl = (f: (b: Body) => string) => {
  let n = 0;
  const per: string[] = [];
  for (const b of bodies) {
    const is = fluencyIssues(main(f(b)), null);
    if (is.length) {
      n += is.length;
      per.push(`${b.key}: ${is.join(" | ")}`);
    }
  }
  return { n, per };
};
const before = fl((b) => b.original);
const after = fl((b) => b.edited);
console.log(`\n===== FLUENCY (gold 192, fluencyIssues) =====`);
console.log(`  before: ${before.n} findings · after: ${after.n} findings  (${after.n - before.n >= 0 ? "+" : ""}${after.n - before.n})`);
const newOnes = after.per.filter((p) => !before.per.includes(p));
const gone = before.per.filter((p) => !after.per.includes(p));
for (const p of newOnes) console.log(`  NEW  ${p}`);
for (const p of gone) console.log(`  GONE ${p}`);

// ---- 5. the metric table ---------------------------------------------------
function metrics(f: (b: Body) => string) {
  const m = { zeroContraction: 0, contractions: 0, bodiesWithContraction: 0, pleasantryOpen: 0, fyr: 0, canResume: 0, canFlex: 0, canEasy: 0, threeI: 0, closeThanksTime: 0, closeAnyThanks: 0, lfth: 0, distinctClose: new Set<string>(), distinctOpen: new Set<string>() };
  for (const b of bodies) {
    const t = main(f(b));
    const ss = sentencesOf(t);
    const c = (t.match(CONTRACTION) ?? []).length;
    m.contractions += c;
    if (c === 0) m.zeroContraction++;
    else m.bodiesWithContraction++;
    if (ss.length && PLEASANTRY.test(ss[0])) m.pleasantryOpen++;
    if (/for your reference/i.test(t)) m.fyr++;
    if (/look forward to hearing from you/i.test(t)) m.lfth++;
    if (CANNED.resumeLine.some((r) => r.test(t))) m.canResume++;
    if (CANNED.flexibilityLine.some((r) => r.test(t))) m.canFlex++;
    if (CANNED.easyOutLine.some((r) => r.test(t))) m.canEasy++;
    let mx = 0, run = 0;
    for (const s of ss) { if (/^I\b|^I’/.test(s)) mx = Math.max(mx, ++run); else run = 0; }
    if (mx >= 3) m.threeI++;
    const close = ss[ss.length - 1] ?? "";
    m.distinctClose.add(close);
    m.distinctOpen.add(ss[0] ?? "");
    if (/^thank(?:s| you)\b/i.test(close)) m.closeAnyThanks++;
    if (/^thank(?:s| you)\b[^.!?]*\bfor (?:your |the |taking the )?time\b/i.test(close)) m.closeThanksTime++;
  }
  return m;
}
const mb = metrics((b) => b.original);
const ma = metrics((b) => b.edited);
console.log(`\n===== METRICS over all 192 gold bodies =====\n`);
const row = (name: string, a: number, b: number, target?: string) =>
  console.log(`  ${name.padEnd(34)} ${String(a).padStart(5)} -> ${String(b).padStart(5)}   ${target ?? ""}`);
row("bodies with 0 contractions", mb.zeroContraction, ma.zeroContraction);
row("bodies with >=1 contraction", mb.bodiesWithContraction, ma.bodiesWithContraction);
row("total contractions", mb.contractions, ma.contractions);
row("opens on a pleasantry", mb.pleasantryOpen, ma.pleasantryOpen);
row("\"for your reference\" bodies", mb.fyr, ma.fyr);
row("\"look forward to hearing from you\"", mb.lfth, ma.lfth);
row("canned resumeLine", mb.canResume, ma.canResume);
row("canned flexibilityLine", mb.canFlex, ma.canFlex);
row("canned easyOutLine", mb.canEasy, ma.canEasy);
row("3+ consecutive I openings", mb.threeI, ma.threeI);
row("closes on a thanks (any)", mb.closeAnyThanks, ma.closeAnyThanks);
row("closes on thanks-for-your-time", mb.closeThanksTime, ma.closeThanksTime);
row("distinct closing strings", mb.distinctClose.size, ma.distinctClose.size);
row("distinct opening strings", mb.distinctOpen.size, ma.distinctOpen.size);

// most-repeated opener/closer after the edits
const tally = (f: (b: Body) => string, which: "open" | "close") => {
  const c = new Map<string, number>();
  for (const b of bodies) {
    const ss = sentencesOf(main(f(b)));
    const k = which === "open" ? ss[0] ?? "" : ss[ss.length - 1] ?? "";
    c.set(k, (c.get(k) ?? 0) + 1);
  }
  return [...c].sort((x, y) => y[1] - x[1]).slice(0, 6);
};
console.log(`\n  most-repeated OPENER after: ${tally((b) => b.edited, "open").map(([k, v]) => `${v}x ${JSON.stringify(k.slice(0, 44))}`).join("  ")}`);
console.log(`  most-repeated CLOSER after: ${tally((b) => b.edited, "close").map(([k, v]) => `${v}x ${JSON.stringify(k.slice(0, 44))}`).join("  ")}`);

// shape variety: no shape should dominate
const shapes = new Map<string, number>();
for (const e of EDITS) shapes.set(e.shape, (shapes.get(e.shape) ?? 0) + 1);
console.log(`\n===== EDIT SHAPES (${EDITS.length} edits, ${shapes.size} distinct shapes) =====`);
for (const [s, n] of [...shapes].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${s}`);
