// TESTER-1: PLAN-A #6. Implement the HALF of the matcher the plan actually specifies
// (contentWords overlap on label+timing, + repliesInThread bonus) and test it.
// The keyword half cannot be implemented: the 41 keyword lists do not exist.
import { EMAIL_TYPES, type EmailTypeId } from "../../src/lib/draft-templates";

const CONTENT_STOP = new Set("about after also been before from have into just like more most much only over some that than their them then there these they this those very what when where which while with would your".split(" "));
const contentWords = (t: string) => (t.toLowerCase().match(/[a-z0-9#]+/g) ?? []).filter((w) => (w.length >= 4 || /\d/.test(w)) && !CONTENT_STOP.has(w));

/** PLAN-A #6's scoring, minus the unwritten `keywords` field. */
function formatsForPurpose(purpose: string, limit = 3, hasThreadSubject = false): { id: EmailTypeId; score: number }[] {
  const pw = new Set(contentWords(purpose).map((w) => w.slice(0, 5)));
  return EMAIL_TYPES.filter((t) => t.id !== "custom").map((t) => {
    const tw = contentWords(`${t.label} ${t.timing}`).map((w) => w.slice(0, 5));
    let score = tw.filter((w) => pw.has(w)).length;
    if (hasThreadSubject && t.repliesInThread) score += 0.5;
    return { id: t.id as EmailTypeId, score };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---- the adversarial set: purposes that are ambiguous, match none, or match many.
type Case = { purpose: string; want: EmailTypeId[]; kind: "clear" | "ambiguous" | "none" | "many" };
const CASES: Case[] = [
  // --- from the repo's own scenario files. NOTE: 8 of the 12 purposes with a
  // real format intent map to NO existing EmailTypeId -> `want: []` (kind "none").
  { purpose: "ask my econ 101 professor if he'd write me a recommendation for the sophomore leadership program, i got an A and went to office hours a lot", want: ["professor_recommendation"], kind: "clear" },
  { purpose: "congratulate rachel on making director, we talked twice last year. no ask", want: ["congratulations","keep_in_touch"], kind: "clear" },
  { purpose: "ask my old manager rob for a linkedin recommendation about the reorder point project", want: [], kind: "none" },
  { purpose: "ask the international office how fast they can issue CPT authorization for a summer internship offer, deadline in 2 weeks", want: [], kind: "none" },
  { purpose: "ask julia if I could shadow her for a day over winter break to see what wealth advisors actually do", want: [], kind: "none" },
  { purpose: "ask emily (we met at a conference) if she'd look at my resume since she got castellan", want: [], kind: "none" },
  { purpose: "invite megan to speak at Rutgers Women in Business on October 22 at 7pm about transaction advisory careers, 30 minutes plus Q&A, virtual is fine", want: [], kind: "none" },
  { purpose: "ask andrew if he'd do a 20 min mock case with me before my tillman gray interview, and if he can tell me what questions they ask", want: [], kind: "none" },
  // long tail that DOES have a format
  { purpose: "withdraw my application, I accepted somewhere else", want: ["withdraw_process"], kind: "clear" },
  { purpose: "turn down the offer politely", want: ["decline_offer"], kind: "clear" },
  { purpose: "I recorded my HireVue yesterday and want to send a short note", want: ["recorded_round_note"], kind: "clear" },
  { purpose: "ask him to be a reference for my background check", want: ["reference_request"], kind: "clear" },
  { purpose: "they rejected me, send a gracious note and ask to stay on their radar", want: ["after_rejection"], kind: "clear" },
  { purpose: "ask for more time to decide on the offer", want: ["offer_extension"], kind: "clear" },
  { purpose: "thank the person who told me about the opening now that I got it", want: ["thank_helper_offer"], kind: "clear" },
  { purpose: "accept the analyst offer", want: ["accept_offer"], kind: "clear" },
  // AMBIGUOUS
  { purpose: "thank her for the call", want: ["thank_you_chat","thank_you_offered_help","thank_you_interview","thank_you_phone_screen"], kind: "ambiguous" },
  { purpose: "follow up, I never heard back", want: ["follow_up_1","follow_up_2","recruiting_inbox_follow_up","stalled_thread_nudge","interview_check_in"], kind: "ambiguous" },
  { purpose: "ask about timing", want: ["call_scheduling","recruiter_scheduling_reply","interview_check_in","offer_extension"], kind: "ambiguous" },
  { purpose: "say thanks and ask to stay in touch", want: ["thank_you_chat","keep_in_touch"], kind: "ambiguous" },
  { purpose: "I need to move our meeting", want: ["reschedule_call","call_scheduling"], kind: "ambiguous" },
  { purpose: "introduce myself", want: ["cold_email","cold_not_alum","cold_referral"], kind: "ambiguous" },
  // MATCHES NONE of the 40
  { purpose: "ask if the firm sponsors the CFA exam fees for interns", want: [], kind: "none" },
  { purpose: "tell them my legal name changed before the background check", want: [], kind: "none" },
  { purpose: "ask whether I can start two weeks late because of summer classes", want: [], kind: "none" },
  { purpose: "apologise for missing the networking dinner", want: [], kind: "none" },
  { purpose: "ask about the dress code for superday", want: [], kind: "none" },
  { purpose: "k", want: [], kind: "none" },
  { purpose: "", want: [], kind: "none" },
  // MATCHES MANY
  { purpose: "thank you for the interview, and also I wanted to follow up on my application and ask about next steps and timing", want: ["thank_you_interview","interview_check_in","follow_up_1"], kind: "many" },
  { purpose: "I got the offer, want to thank my referrer, tell the recruiter I accept, and ask my old manager for a reference", want: ["accept_offer","close_loop_referrer","reference_request","thank_helper_offer"], kind: "many" },
  { purpose: "recommendation letter reference recommendation professor grad school interview thank you offer", want: ["professor_recommendation","reference_request"], kind: "many" },
];

let r1 = 0, r3 = 0, r4 = 0, n = 0, nTies = 0;
const fails: string[] = [];
console.log(`types available: ${EMAIL_TYPES.length - 1} non-custom\n`);
for (const c of CASES) {
  const top = formatsForPurpose(c.purpose, 4);
  const ids = top.map((t) => t.id);
  const hit1 = c.want.length > 0 && c.want.includes(ids[0]);
  const hit3 = c.want.length > 0 && ids.slice(0, 3).some((i) => c.want.includes(i));
  const hit4 = c.want.length > 0 && ids.slice(0, 4).some((i) => c.want.includes(i));
  if (c.want.length > 0) { n++; if (hit1) r1++; if (hit3) r3++; if (hit4) r4++; }
  const allZero = top.every((t) => t.score === 0);
  if (allZero) nTies++;
  const mark = c.want.length === 0 ? (allZero ? "ok(no-match, floor fires)" : `FALSE CONFIDENCE -> ${ids.slice(0,3).join(",")}`) : hit3 ? "recall@3 OK" : "MISS@3";
  if (c.want.length > 0 && !hit3) fails.push(`${c.kind}: "${c.purpose.slice(0, 70)}" -> ${ids.slice(0,3).join(", ")} (want ${c.want.join("|")})`);
  if (c.want.length === 0 && !allZero) fails.push(`${c.kind}: "${c.purpose.slice(0, 70)}" -> ${ids.slice(0,3).join(", ")} scores ${top.slice(0,3).map(t=>t.score).join("/")} (should score 0 and hit the floor)`);
  console.log(`[${c.kind.padEnd(9)}] ${mark.padEnd(28)} ${ids.slice(0,3).join(", ")}  scores ${top.slice(0,3).map(t=>t.score.toFixed(1)).join("/")}   <- "${c.purpose.slice(0,55)}"`);
}
console.log(`\nlabelled cases: ${n}`);
console.log(`recall@1 = ${r1}/${n} = ${(100*r1/n).toFixed(0)}%   (PLAN-A #6 pass bar: >=60%)`);
console.log(`recall@3 = ${r3}/${n} = ${(100*r3/n).toFixed(0)}%   (PLAN-A #6 pass bar: >=90%)`);
console.log(`recall@4 = ${r4}/${n} = ${(100*r4/n).toFixed(0)}%   (PLAN-A #6 fallback bar: >=90% at limit=4, else REJECT)`);
console.log(`cases where every score is 0 (the floor fires): ${nTies}/${CASES.length}`);
console.log(`\nfailures:`);
for (const f of fails) console.log("  " + f);
