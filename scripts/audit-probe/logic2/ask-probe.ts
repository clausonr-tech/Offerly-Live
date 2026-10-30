// LOGIC-2: re-derive the ASK claim (90% recall / 100% precision) and attribute matches per alternative.
import { ASK } from "../../../src/lib/draft-lint";
import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";
import { gold, mainText } from "./corpus";

const ALTS: [string, RegExp][] = [
  ["would you have/be open...", /\bwould you (?:have|be (?:open|willing|free|comfortable|available)|prefer|mind)\b/i],
  ["could we/you", /\bcould (?:we|you)\b/i],
  ["do you have time", /\bdo you have (?:time|any time|a moment|availability)\b/i],
  ["any chance you", /\bany chance you\b/i],
  ["would any of the following", /\bwould any of (?:the following|these|those)\b/i],
  ["you would feel comfortable", /\byou would (?:feel comfortable|be willing|mind)\b/i],
  ["if you have ... minutes", /\bif you (?:have|had|ever have|can spare|are able to find|find|do have)\b[^.!?]{0,60}\b(?:minutes?|moment|time|feedback)\b/i],
  ["I'd love ... call/hear", /\bI(?:'d|’d| would) (?:love|welcome|appreciate|be grateful|value)\b[^.!?]{0,80}\b(?:call|chat|talk|speak|hear|conversation|update|feedback|minutes?|perspectives?)\b/i],
  ["would welcome ... call", /\bwould (?:welcome|appreciate|be grateful for)\b[^.!?]{0,60}\b(?:call|chat|update|feedback|conversation|input)\b/i],
  ["whether ... call", /\bwhether\b[^.!?]{0,60}\b(?:call|chat|minutes?)\b/i],
  ["let me know", /\blet me know\b/i],
  ["wanted to ask/confirm", /\bwanted to (?:ask|confirm)\b/i],
];

const ASK_SAMPLE: [string, boolean][] = [
  ["accept_offer", true], ["after_rejection", true], ["call_scheduling", true], ["close_loop_referrer", false],
  ["coffee_in_person_reply", true], ["cold_after_meeting", true], ["cold_email", true], ["cold_not_alum", true],
  ["cold_referral", true], ["conference_follow_up", true], ["congratulations", false], ["decline_offer", false],
  ["follow_up_1", true], ["follow_up_2", true], ["interview_check_in", true], ["keep_in_touch", true],
  ["not_now_reply", false], ["offer_extension", true], ["professor_recommendation", true], ["recorded_round_note", true],
  ["recruiter_follow_up", true], ["recruiter_outreach", true], ["recruiter_scheduling_reply", true], ["recruiting_inbox", true],
  ["recruiting_inbox_follow_up", true], ["redirect_sequence", true], ["reference_request", true], ["referral_ask", true],
  ["reschedule_call", true], ["second_conversation", true], ["stalled_thread_nudge", true], ["thank_helper_offer", false],
  ["thank_you_chat", true], ["thank_you_event", true], ["thank_you_interview", false], ["thank_you_offered_help", false],
  ["thank_you_phone_screen", false], ["thank_you_recruiter_session", true], ["thank_you_superday", false], ["withdraw_process", false],
];

const examples = EMAIL_EXAMPLES as Record<string, { body: string }[]>;
const mode = process.argv[2] ?? "summary";

function whichAlts(text: string) {
  return ALTS.filter(([, re]) => re.test(text)).map(([n]) => n);
}

if (mode === "sample") {
  let tp = 0, fp = 0, fn = 0;
  for (const [type, isAsk] of ASK_SAMPLE) {
    const body = examples[type][0].body;
    const hit = ASK.test(body);
    if (hit && isAsk) tp++;
    else if (hit && !isAsk) fp++;
    else if (!hit && isAsk) fn++;
    const tag = hit === isAsk ? "ok " : hit ? "FP " : "FN ";
    console.log(`${tag}${type.padEnd(32)} label=${isAsk ? "ask " : "none"} hit=${hit}  [${whichAlts(body).join(" | ")}]`);
    console.log(`    match: ${JSON.stringify(body.match(ASK)?.[0] ?? null)}`);
  }
  console.log(`\nTP=${tp} FP=${fp} FN=${fn}  recall=${(100 * tp / (tp + fn)).toFixed(1)}%  precision=${(100 * tp / Math.max(1, tp + fp)).toFixed(1)}%`);
}

if (mode === "print") {
  for (const t of process.argv.slice(3)) {
    console.log(`\n================ ${t}`);
    console.log(examples[t][0].body);
  }
}

if (mode === "corpus") {
  const g = gold();
  const hits = g.filter((x) => ASK.test(x.body));
  console.log(`gold bodies: ${g.length}; ASK matches whole body: ${hits.length}`);
  const perType = g.filter((x) => x.corpus === "per-type");
  console.log(`per-type (192): ${perType.filter((x) => ASK.test(x.body)).length}`);
  // per-alternative attribution, and sole-cause counts
  const rows: Record<string, { hit: number; sole: number }> = {};
  for (const [n] of ALTS) rows[n] = { hit: 0, sole: 0 };
  for (const x of g) {
    const w = whichAlts(x.body);
    for (const n of w) rows[n].hit++;
    if (w.length === 1) rows[w[0]].sole++;
  }
  console.log("\nalternative".padEnd(34) + "bodies".padStart(8) + "sole".padStart(7));
  for (const [n] of ALTS) console.log(n.padEnd(34) + String(rows[n].hit).padStart(8) + String(rows[n].sole).padStart(7));
}

if (mode === "letmeknow") {
  // Every "let me know" sentence in gold, to judge offer vs ask.
  const g = gold();
  let n = 0;
  for (const x of g) {
    const sentences = mainText(x.body).replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"])/);
    for (const s of sentences) {
      if (/\blet me know\b/i.test(s)) { n++; console.log(`${x.id.padEnd(30)} ${s.trim()}`); }
    }
  }
  console.log(`\n${n} "let me know" sentences in gold`);
}

if (mode === "firstmatch") {
  // Which sentence index ASK first matches, vs the LAST matching sentence.
  const g = gold();
  let differs = 0;
  for (const x of g) {
    const sentences = mainText(x.body).replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"])/).map((s) => s.trim()).filter(Boolean);
    const idx = sentences.map((s, i) => (ASK.test(s) ? i : -1)).filter((i) => i >= 0);
    if (idx.length > 1) {
      differs++;
      console.log(`${x.id.padEnd(28)} asks at ${idx.join(",")} of ${sentences.length}`);
      console.log(`   first: ${sentences[idx[0]]}`);
      console.log(`   last : ${sentences[idx[idx.length - 1]]}`);
    }
  }
  console.log(`\n${differs} gold bodies where ASK matches more than one sentence`);
}

if (mode === "heldout") {
  // Precision on the SAME ten types the sample labels "no ask", but on the
  // examples the sample never read (#2 onwards).
  const NONE = ["close_loop_referrer", "congratulations", "decline_offer", "not_now_reply", "thank_helper_offer",
    "thank_you_interview", "thank_you_offered_help", "thank_you_phone_screen", "thank_you_superday", "withdraw_process"];
  let n = 0, hit = 0;
  for (const t of NONE) {
    (examples[t] ?? []).slice(1).forEach((e, i) => {
      n++;
      const m = e.body.match(ASK);
      if (m) {
        hit++;
        const sent = mainText(e.body).replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"])/).find((s) => ASK.test(s));
        console.log(`HIT ${t}#${i + 2}  via ${JSON.stringify(m[0])}\n    ${sent?.trim()}`);
      }
    });
  }
  console.log(`\nheld-out bodies of the ten no-ask types: ${n}; ASK fires on ${hit}`);
}

if (mode === "offeronly") {
  // Bodies whose ONLY ASK evidence is an offer-shaped courtesy sentence: if the
  // reviewer deletes that canned line, the guard says "dropped the ask".
  const OFFER = /let me know (?:if|whether)?[^.!?]{0,40}\banything (?:else|further|more)\b|\banything (?:else|further)[^.!?]{0,40}\b(?:need|needed|needs)\b|\bif anything (?:else|further)\b|\banything else (?:I|you)\b|do not hesitate/i;
  const g = gold();
  let n = 0;
  for (const x of g) {
    if (!ASK.test(x.body)) continue;
    const sentences = mainText(x.body).replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"])/).map((s) => s.trim()).filter(Boolean);
    const matching = sentences.filter((s) => ASK.test(s));
    if (matching.length && matching.every((s) => OFFER.test(s))) {
      n++;
      console.log(`${x.id.padEnd(30)} ${matching.map((s) => JSON.stringify(s)).join(" ")}`);
    }
  }
  console.log(`\n${n} gold bodies where every ASK-matching sentence is offer-shaped`);
}

if (mode === "ordering") {
  // The ask-ordering judgement, on constructed inputs.
  const { fluencyIssues } = require("../../../src/lib/draft-lint");
  const cases: [string, string][] = [
    ["FP: no ask at all, a courtesy offer before a congratulation",
      "I hope your week is going well. Please let me know if there is anything else you need from me. I also saw that you were promoted to Vice President this month, so congratulations to you."],
    ["FN: a real imperative ask, congratulations after it",
      "I am flexible next week and will work around you. Please just name a time and I will make it work. I also saw the promotion news, so congratulations on that."],
    ["TP control: a softened ask, congratulations after it",
      "Would you have 15 minutes in the next two weeks for a call. I also saw the promotion news, so congratulations on that."],
  ];
  for (const [label, text] of cases) {
    console.log(`${label}\n  -> ${JSON.stringify(fluencyIssues(text, null))}\n  askMatch=${JSON.stringify(text.match(ASK)?.[0] ?? null)}`);
  }
}
