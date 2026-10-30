// TESTER-1 probe: implement PLAN-A #3's tiering exactly as specified and count keys.
import { OCCASIONS, resolveSituation, situationTypes } from "../../src/lib/draft-occasions";
import { EMAIL_TYPES, emailTypeById, type EmailTypeId } from "../../src/lib/draft-templates";
import { buildDraftPrompt, type DraftPromptInput } from "../../src/lib/draft-prompt";
import { sims } from "../draft-occasions-sim";

const CPT = 3.7; const tok = (s: string) => Math.round(s.length / CPT);
const BASE = sims()[0];
function subsets<T>(xs: T[]): T[][] { const o: T[][] = []; for (let m = 1; m < 1 << xs.length; m++) { const s: T[] = []; for (let i = 0; i < xs.length; i++) if (m & (1 << i)) s.push(xs[i]); o.push(s); } return o; }

type Row = { lead: EmailTypeId; also: EmailTypeId[]; boxIds: string[]; system: string; label: string };
const rows: Row[] = [];
for (const occ of OCCASIONS) {
  for (const combo of subsets(occ.sections.flatMap((s) => s.boxes.map((b) => b.id)))) {
    const r = resolveSituation(occ.id, combo); if ("error" in r) continue;
    const t = situationTypes(r); const lead = t[0].id; const also = t.slice(1).map((x) => x.id);
    rows.push({ lead, also, boxIds: combo, label: r.summary,
      system: buildDraftPrompt({ ...BASE.input, type: lead, alsoTypes: also, boxIds: combo, situationSummary: r.summary }).system });
  }
}
console.log(`combinations: ${rows.length}; distinct system strings: ${new Set(rows.map(r => r.system)).size}; distinct lead types: ${new Set(rows.map(r => r.lead)).size}`);

// Today's single terminal breakpoint => one cache key per distinct system string.
console.log(`today's cache keys (distinct full system strings): ${new Set(rows.map(r => r.system)).size}`);

// --- the plan's three tiers, cut out of the real system string
const HEAD_END = "- Then write the body from the plan, sentence for sentence.";
const TAIL_START = "\n\nFINDING COMMON GROUND";
const CEIL = /\nHARD CEILING: \d+ words in the body, signature excluded\. A ceiling, not a target\./;

type Tiers = { invariant: string; perType: string; perRequest: string };
function tiersOf(r: Row): Tiers {
  const s = r.system;
  const h = s.indexOf(HEAD_END) + HEAD_END.length;
  const t = s.lastIndexOf(TAIL_START);
  const head = s.slice(0, h);
  const tail = s.slice(t + 2);
  const mid = s.slice(h + 2, t); // between head and tail
  // mid = formatBlock [+ blendRules] + examplesBlock [+ combinedExamplesBlock]
  // perType per the plan = formatBlock minus the ceiling line + examplesBlock
  const ceilMatch = mid.match(CEIL);
  const ceilLine = ceilMatch ? ceilMatch[0] : "";
  const midNoCeil = ceilMatch ? mid.replace(CEIL, "") : mid;
  // split off blendRules + combinedExamples (the per-request parts)
  const blendStart = midNoCeil.indexOf("SEVERAL THINGS ARE TRUE AT ONCE.");
  const combStart = midNoCeil.indexOf("COMBINATION FORMAT - how the playbook folds");
  let perType = midNoCeil, perRequest = ceilLine;
  if (blendStart >= 0) {
    // order in the real prompt: format, blend, examples, combined
    const afterBlend = midNoCeil.indexOf("\n\nEXAMPLES", blendStart) >= 0
      ? midNoCeil.indexOf("\n\nEXAMPLES", blendStart)
      : midNoCeil.indexOf("\n\nCOMBINATION FORMAT", blendStart);
    const blend = midNoCeil.slice(blendStart, afterBlend < 0 ? undefined : afterBlend);
    perRequest += "\n\n" + blend;
    perType = midNoCeil.slice(0, blendStart - 2) + (afterBlend < 0 ? "" : midNoCeil.slice(afterBlend));
  }
  const c2 = perType.indexOf("COMBINATION FORMAT - how the playbook folds");
  if (c2 >= 0) { perRequest += "\n\n" + perType.slice(c2); perType = perType.slice(0, c2 - 2); }
  return { invariant: head + "\n\n" + tail, perType, perRequest };
}

const inv = new Set<string>(), pt = new Set<string>(), pr = new Set<string>();
const ptByType = new Map<EmailTypeId, Set<string>>();
for (const r of rows) {
  const t = tiersOf(r);
  inv.add(t.invariant); pt.add(t.perType); pr.add(t.perRequest);
  if (!ptByType.has(r.lead)) ptByType.set(r.lead, new Set());
  ptByType.get(r.lead)!.add(t.perType);
}
console.log(`\nPLAN #3 tiering over the ${rows.length} combinations:`);
console.log(`  distinct invariant blocks : ${inv.size}  (plan claims 1)`);
console.log(`  distinct perType blocks   : ${pt.size}  (plan claims 41)`);
console.log(`  distinct perRequest blocks: ${pr.size}`);
const leaky = [...ptByType.entries()].filter(([, v]) => v.size > 1);
console.log(`  lead types with MORE THAN ONE perType value (= mix leaking into the per-type tier): ${leaky.length}`);
for (const [k, v] of leaky) console.log(`     ${k}: ${v.size} distinct perType strings`);

// token sizes
const i0 = [...inv][0];
console.log(`\ninvariant tier: ${i0.length} ch / ~${tok(i0)} tok  (min cacheable prefix is 1024 tok)`);
const ptSizes = [...pt].map((s) => tok(s)).sort((a, b) => a - b);
console.log(`perType tier tokens: min ${ptSizes[0]}, median ${ptSizes[Math.floor(ptSizes.length/2)]}, max ${ptSizes[ptSizes.length-1]}`);
const prSizes = [...pr].map((s) => tok(s)).sort((a, b) => a - b);
console.log(`perRequest tier tokens: min ${prSizes[0]}, median ${prSizes[Math.floor(prSizes.length/2)]}, max ${prSizes[prSizes.length-1]}`);

// --- is the invariant text really "all downstream of the first varying byte"?
function lcp(a: string, b: string) { let n = 0; const m = Math.min(a.length, b.length); while (n < m && a[n] === b[n]) n++; return n; }
let p = rows[0].system.length; for (const r of rows) p = Math.min(p, lcp(rows[0].system, r.system));
const head = rows[0].system.slice(0, rows[0].system.indexOf(HEAD_END) + HEAD_END.length);
const tail = rows[0].system.slice(rows[0].system.lastIndexOf(TAIL_START) + 2);
console.log(`\nfirst varying byte across all ${rows.length}: offset ${p}`);
console.log(`invariant HEAD  ${head.length} ch: ends at offset ${head.length} -> ${head.length <= p ? "UPSTREAM of divergence" : "DOWNSTREAM"}`);
console.log(`invariant TAIL  ${tail.length} ch: starts after divergence -> DOWNSTREAM`);
console.log(`share of invariant text that is DOWNSTREAM: ${(100*tail.length/(head.length+2+tail.length)).toFixed(1)}%  (tokens ~${tok(tail)} of ~${tok(head)+tok(tail)})`);
console.log(`=> a single extra breakpoint after the head, with NO reorder, already captures ~${tok(head)} tok of the ~${tok(head)+tok(tail)} tok invariant tier.`);

// custom: does formatBlock("custom") even have a HARD CEILING line?
const customRow = rows.find((r) => r.lead === "custom");
if (customRow) {
  console.log(`\ncustom row: HARD CEILING line present in system prompt? ${CEIL.test(customRow.system)}`);
}
const customType = EMAIL_TYPES.find(t=>t.id==="custom");
const fb = buildDraftPrompt({ ...BASE.input, type: "custom", alsoTypes: [], boxIds: ["custom"], situationSummary: "c" }).system;
console.log(`custom (direct) HARD CEILING present? ${CEIL.test(fb)}; maxWords=${customType?.maxWords}`);
