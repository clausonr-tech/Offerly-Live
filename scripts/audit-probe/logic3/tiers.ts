// LOGIC-3 probe: the tier split's invariants, and attempts to break them.
import { buildDraftPrompt, type DraftPromptInput } from "@/lib/draft-prompt";
import { EMAIL_TYPES } from "@/lib/draft-templates";
import { sims } from "../../draft-occasions-sim";
import { allCombos } from "./enumerate";

const inv = new Set<string>(), per = new Set<string>(), req = new Set<string>();
let n = 0, byteFail = 0, emptyTier: string[] = [];
const record = (label: string, input: DraftPromptInput) => {
  const { system, systemTiers: t } = buildDraftPrompt(input);
  n++;
  inv.add(t.invariant); per.add(t.perType); req.add(t.perRequest);
  if (t.invariant + t.perType + t.perRequest !== system) byteFail++;
  for (const [k, v] of Object.entries(t)) if (v.length === 0 || v.trim().length === 0) emptyTier.push(`${label}: ${k} empty`);
};

// 1. Every single-box situation, as a bare prompt per type.
for (const t of EMAIL_TYPES) {
  record(`single ${t.id}`, { type: t.id, contactName: "Rachel Stein", studentName: "Maya", studentSchool: "Duke", now: new Date("2026-09-20") } as DraftPromptInput);
}
// 2. Every multi-box combination, full and sparse, from the committed harness.
for (const s of sims()) record(`sim ${s.id}`, s.input);
// 3. Hostile / unusual shapes.
const base = { contactName: "Rachel Stein", studentName: "Maya", studentSchool: "Duke", now: new Date("2026-09-20") };
const hostile: [string, DraftPromptInput][] = [
  ["custom, no boxes", { ...base, type: "custom" } as DraftPromptInput],
  ["custom, boxIds []", { ...base, type: "custom", boxIds: [] } as DraftPromptInput],
  ["custom, 3 unknown boxIds", { ...base, type: "custom", boxIds: ["zz.a", "zz.b", "zz.c"] } as DraftPromptInput],
  ["cold_email, 2 unknown boxIds", { ...base, type: "cold_email", boxIds: ["zz.a", "zz.b"] } as DraftPromptInput],
  ["cold_email, alsoTypes = [cold_email] (self)", { ...base, type: "cold_email", alsoTypes: ["cold_email"] } as DraftPromptInput],
  ["thank_you_chat with referral boxIds", { ...base, type: "thank_you_chat", boxIds: ["first.alum", "first.referred"] } as DraftPromptInput],
  ["every type as alsoTypes", { ...base, type: "cold_email", alsoTypes: EMAIL_TYPES.filter((t) => t.id !== "cold_email").map((t) => t.id) } as DraftPromptInput],
];
for (const [label, input] of hostile) {
  try { record(label, input); console.log(`  ok   ${label}`); }
  catch (e) { console.log(`  THROW ${label}: ${(e as Error).message}`); }
}

console.log(`\nprompts built: ${n}`);
console.log(`invariant distinct values: ${inv.size}  (must be 1)`);
console.log(`perType  distinct values: ${per.size}`);
console.log(`perRequest distinct values: ${req.size}`);
console.log(`byte-identity failures (invariant+perType+perRequest !== system): ${byteFail}`);
console.log(`empty/whitespace-only tiers: ${emptyTier.length}`);
emptyTier.forEach((e) => console.log("  " + e));

// Does a prompt with 3+ unknown boxIds get a combination block it should not?
const odd = buildDraftPrompt({ ...base, type: "cold_email", boxIds: ["zz.a", "zz.b", "zz.c"] } as DraftPromptInput);
console.log(`\n3 unknown boxIds, single type -> COMBINATION FORMAT block present: ${odd.system.includes("COMBINATION FORMAT")}`);
const mismatch = buildDraftPrompt({ ...base, type: "thank_you_chat", boxIds: ["first.alum", "first.referred"] } as DraftPromptInput);
console.log(`boxIds that disagree with the type -> referral combination examples present: ${mismatch.system.includes("COMBINATION EXAMPLES")}`);
console.log(`  ... inside a thank_you_chat prompt (lead type in the format block): ${/EMAIL TYPE: [^\n]*/.exec(mismatch.system)?.[0]}`);

// The ceiling the mix produces.
const ceilings = new Set<string>();
for (const c of allCombos()) ceilings.add(String(c.ids.length));
console.log(`\nHARD CEILING line, worst mix:`, /HARD CEILING: \d+ words/.exec(buildDraftPrompt({ ...base, type: "congratulations", alsoTypes: ["cold_email"] } as DraftPromptInput).system)?.[0]);
