// TESTER-1 probe: is the "invariant tail" byte-identical across every type and
// every valid box mix? Exhaustive, offline, no API.
import { OCCASIONS, resolveSituation, situationTypes } from "../../src/lib/draft-occasions";
import { EMAIL_TYPES, type EmailTypeId } from "../../src/lib/draft-templates";
import { buildDraftPrompt, type DraftPromptInput } from "../../src/lib/draft-prompt";
import { sims } from "../draft-occasions-sim";

const CPT = 3.7;
const tok = (s: string) => Math.round(s.length / CPT);
const BASE = sims()[0];

function subsets<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let m = 1; m < 1 << xs.length; m++) {
    const s: T[] = [];
    for (let i = 0; i < xs.length; i++) if (m & (1 << i)) s.push(xs[i]);
    out.push(s);
  }
  return out;
}

type Case = { occ: string; boxIds: string[]; lead: EmailTypeId; also: EmailTypeId[]; system: string; label: string };
const cases: Case[] = [];
for (const occ of OCCASIONS) {
  const boxes = occ.sections.flatMap((s) => s.boxes.map((b) => b.id));
  for (const combo of subsets(boxes)) {
    const r = resolveSituation(occ.id, combo);
    if ("error" in r) continue;
    const types = situationTypes(r);
    const lead = types[0].id;
    const also = types.slice(1).map((t) => t.id);
    const input: DraftPromptInput = { ...BASE.input, type: lead, alsoTypes: also, boxIds: combo, situationSummary: r.summary };
    cases.push({ occ: occ.id, boxIds: combo, lead, also, system: buildDraftPrompt(input).system, label: r.summary });
  }
}

// Also add every reachable type as a lone-box row (draft-bench's matrix), so
// types with no occasion box are covered too.
const boxesForType = new Map<EmailTypeId, string[]>();
for (const o of OCCASIONS) for (const s of o.sections) for (const b of s.boxes) boxesForType.set(b.typeId, [...(boxesForType.get(b.typeId) ?? []), b.id]);
const typeOnly: Case[] = EMAIL_TYPES.map((t) => {
  const boxIds = (boxesForType.get(t.id) ?? []).slice(0, 1);
  const input: DraftPromptInput = { ...BASE.input, type: t.id, alsoTypes: [], boxIds, situationSummary: t.label };
  return { occ: "typeRow", boxIds, lead: t.id, also: [], system: buildDraftPrompt(input).system, label: t.label };
});

const all = [...cases, ...typeOnly];
console.log(`valid box combinations (occasion subsets): ${cases.length}`);
console.log(`per-type rows (41 EMAIL_TYPES, one box each):  ${typeOnly.length}`);
console.log(`total prompts built:                          ${all.length}`);
console.log(`distinct lead types across combinations:      ${new Set(cases.map((c) => c.lead)).size}`);
console.log(`distinct system strings (all):                 ${new Set(all.map((c) => c.system)).size}`);

// ---- longest common suffix / prefix, byte-exact, over ALL prompts
function lcs(a: string, b: string) { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; }
function lcp(a: string, b: string) { let n = 0; const m = Math.min(a.length, b.length); while (n < m && a[n] === b[n]) n++; return n; }
let suf = all[0].system.length, pre = all[0].system.length;
for (const c of all.slice(1)) { suf = Math.min(suf, lcs(all[0].system, c.system)); pre = Math.min(pre, lcp(all[0].system, c.system)); }
const sufText = all[0].system.slice(all[0].system.length - suf);
const preText = all[0].system.slice(0, pre);
console.log(`\nlongest common PREFIX over all ${all.length}: ${pre} ch / ${Buffer.byteLength(preText)} B / ~${tok(preText)} tok`);
console.log(`longest common SUFFIX over all ${all.length}: ${suf} ch / ${Buffer.byteLength(sufText)} B / ~${tok(sufText)} tok`);
console.log(`suffix starts with: ${JSON.stringify(sufText.slice(0, 90))}`);
console.log(`prefix ends with:   ${JSON.stringify(preText.slice(-90))}`);
console.log(`prefix+suffix = ${pre + suf} ch / ~${tok(preText) + tok(sufText)} tok`);

// ---- the plan's specific claim: the 4-block tail, byte-identical everywhere
const tailStart = "FINDING COMMON GROUND";
let tailMismatch = 0; const tailVals = new Set<string>();
for (const c of all) {
  const i = c.system.lastIndexOf("\n\n" + tailStart);
  if (i < 0) { console.log(`NO TAIL MARKER: ${c.lead} ${c.boxIds.join("+")}`); tailMismatch++; continue; }
  tailVals.add(c.system.slice(i + 2));
}
const tail = [...tailVals][0];
console.log(`\ndistinct values of the CONNECTION_RULES..end tail: ${tailVals.size} (missing marker: ${tailMismatch})`);
console.log(`tail size: ${tail.length} ch / ${Buffer.byteLength(tail)} B / ~${tok(tail)} tok`);

// ---- head: role line + HOUSE + STUDENT_DETAILS + PLAN_RULES
const headEnd = "- Then write the body from the plan, sentence for sentence.";
const h = all[0].system.indexOf(headEnd);
const head = all[0].system.slice(0, h + headEnd.length);
let headMismatch = 0;
for (const c of all) if (!c.system.startsWith(head)) headMismatch++;
console.log(`head (role+HOUSE+STUDENT_DETAILS+PLAN): ${head.length} ch / ~${tok(head)} tok; prompts not starting with it: ${headMismatch}`);
console.log(`head+tail invariant total: ${head.length + tail.length} ch / ~${tok(head) + tok(tail)} tok`);
