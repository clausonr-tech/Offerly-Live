// CORPUS-PLAN probe 4: the prefix property. Applies the edit table one tier at
// a time and reports the headline metrics after each, to show that stopping
// after any tier leaves a coherent, net-positive corpus. READ-ONLY, in memory.
import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";
import { fluencyIssues } from "../../../src/lib/draft-lint";
import { EDITS } from "./edits";

const TIERS: [string, string[]][] = [
  ["1a cold_referral", ["cold_referral"]],
  ["1b cold_after_meeting", ["cold_after_meeting"]],
  ["1c cold_email", ["cold_email"]],
  ["1d cold_not_alum", ["cold_not_alum"]],
  ["2  recruiting_inbox", ["recruiting_inbox"]],
  ["3a remaining for-your-reference", ["conference_follow_up", "redirect_sequence"]],
  ["3b repeated pleasantry openers", ["follow_up_1", "follow_up_2", "second_conversation", "keep_in_touch", "interview_check_in", "referral_ask"]],
  ["3c do-not-hesitate / 3d lfth", ["call_scheduling", "thank_you_interview", "thank_you_superday"]],
];
const CONTRACTION = /\b(?:I|you|we|they|he|she|it|that|there|here|what|who|how|let|this|y'all)['’](?:m|re|ve|ll|d|s)\b|\b\w+n['’]t\b/gi;
const PLEASANTRY = /^(?:[^.!?]{0,40}\b)?(?:I hope (?:this|you|your|all|things)|hope (?:you|this|all|your|things)|I trust you|how are you|hope all is well)\b/i;
const FLEX = [/\b(?:more than )?(?:happy|glad) to work around your schedule\b/i, /\bat your (?:earliest )?convenience\b/i, /\bwhatever (?:time |day |day or time )?works best for you\b/i, /\bwhenever (?:is |works )(?:most )?convenient\b/i, /\bI(?:'m| am) flexible (?:on|with|around) (?:timing|time|your schedule|whatever)\b/i, /\bany time that suits you works for me\b/i];
const ss = (t: string) => t.replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"])/).map((s) => s.trim()).filter(Boolean);
function mainOf(b: string) { const l = b.split("\n"); const s = l.map((x) => x.trim()).lastIndexOf("Best,"); const a = (s >= 0 ? l.slice(0, s) : l).join("\n").trim(); return a.split("\n").slice(1).join("\n").trim(); }
const state = new Map<string, string>();
for (const [t, ex] of Object.entries(EMAIL_EXAMPLES as Record<string, { body: string }[]>)) ex.forEach((e, i) => state.set(`${t}#${i + 1}`, e.body));

function snap(label: string, applied: number) {
  const b = [...state.values()].map(mainOf);
  const fyr = b.filter((t) => /for your reference/i.test(t)).length;
  const flex = b.filter((t) => FLEX.some((r) => r.test(t))).length;
  const hes = b.filter((t) => /do not hesitate/i.test(t)).length;
  const pl = b.filter((t) => { const s = ss(t); return s.length > 0 && PLEASANTRY.test(s[0]); }).length;
  const con = b.filter((t) => (t.match(CONTRACTION) ?? []).length > 0).length;
  const ctime = b.filter((t) => { const s = ss(t); return /^thank(?:s| you)\b[^.!?]*\bfor (?:your |the |taking the )?time\b/i.test(s[s.length - 1] ?? ""); }).length;
  const opens = new Set(b.map((t) => ss(t)[0] ?? "")).size;
  const closes = new Set(b.map((t) => { const s = ss(t); return s[s.length - 1] ?? ""; })).size;
  const fl = b.reduce((a, t) => a + fluencyIssues(t, null).length, 0);
  const w = b.reduce((a, t) => a + t.split(/\s+/).filter(Boolean).length, 0);
  console.log(
    `${label.padEnd(34)}${String(applied).padStart(4)} ${String(fyr).padStart(4)} ${String(flex).padStart(5)} ${String(hes).padStart(4)} ` +
    `${String(pl).padStart(5)} ${String(con).padStart(5)} ${String(ctime).padStart(6)} ${String(opens).padStart(6)} ${String(closes).padStart(7)} ${String(fl).padStart(4)} ${String(w).padStart(6)}`,
  );
}
console.log(`${"after tier".padEnd(34)}${"n".padStart(4)} ${"fyr".padStart(4)} ${"flex".padStart(5)} ${"hes".padStart(4)} ${"pleas".padStart(5)} ${"contr".padStart(5)} ${"cTime".padStart(6)} ${"opens".padStart(6)} ${"closes".padStart(7)} ${"flu".padStart(4)} ${"words".padStart(6)}`);
snap("(baseline)", 0);
let n = 0;
for (const [label, types] of TIERS) {
  for (const e of EDITS) {
    if (!types.includes(e.key.split("#")[0])) continue;
    const cur = state.get(e.key)!;
    if (cur.split(e.find).length - 1 !== 1) { console.log(`  !! ${e.key} find not unique at tier ${label}`); continue; }
    state.set(e.key, cur.replace(e.find, e.replace));
    n++;
  }
  snap(label, n);
}
console.log(`\n${n} of ${EDITS.length} edits accounted for by the tier map`);
