// Parses the PDFKit text dump of Volume IV into { typeId: [{ section, note, subject, body }] }.
import { readFileSync, writeFileSync } from "node:fs";

const S = new URL(".", import.meta.url).pathname;
const lines = readFileSync(S + "volume4.txt", "utf8")
  .split("\n")
  .filter((l) => !/^===== PAGE \d+ =====$/.test(l) && !/^PAGES: /.test(l) && !/^Fictional examples, page \d+$/.test(l) && l !== "");

// [section, title prefix, type for every example or one type per example]
const SECTIONS = [
  [1, "1. After a Recorded or Virtual Round", "recorded_round_note"],
  [2, "2. Thank You After a Superday: Two Harder Cases", "thank_you_superday"],
  [3, "3. Thank You After a Recruiter Phone Screen: Two Harder Cases", "thank_you_phone_screen"],
  [4, "4. Asking for an Offer Deadline Extension: Two More Cases", "offer_extension"],
  [5, "5. Rescheduling or Canceling: Two More Cases", "reschedule_call"],
  [6, "6. Follow Up to a Recruiting Inbox: Eligibility Question", "recruiting_inbox_follow_up"],
  [7, "7. Asking a Professor for a Recommendation Letter", "professor_recommendation"],
  [8, "8. Asking a Former Manager for a Reference or LinkedIn", "reference_request"],
  [9, "9. Congratulating a Contact, With No Ask", "congratulations"],
  [10, "10. Following Up After a Conference or Large Event", "conference_follow_up"],
  [11, "11. MBA and Graduate Students", ["cold_email", "cold_after_meeting", "recruiter_outreach", "after_rejection", "accept_offer"]],
  [12, "12. Transfer Students", ["cold_email", "recruiting_inbox", "thank_you_interview"]],
  [13, "13. International Students Who Will Need Sponsorship", ["recruiting_inbox", "thank_you_interview"]],
  [14, "14. Seniors Recruiting Late", ["cold_email", "recruiting_inbox"]],
  [15, "15. Cold Email to a Campus Recruiter You Met", "recruiter_outreach"],
  [16, "16. Follow Up to a Recruiter Who Has Not Replied", "recruiter_follow_up"],
  [17, "17. Thank You to a Recruiter After an Info Session They Ran", "thank_you_recruiter_session"],
  [18, "18. When They Say Not Now", "not_now_reply"],
  [19, "19. When They Point You to Someone Else", "redirect_sequence"],
  [20, "20. When They Go Quiet or Do Not Answer the Question", "stalled_thread_nudge"],
  [21, "21. Reply When They Suggest Coffee in Person", "coffee_in_person_reply"],
  [22, "22. Asking for a Second Conversation", "second_conversation"],
  [23, "23. Declining an Interview or Withdrawing From a Process", "withdraw_process"],
  [24, "24. When a Better Offer Appears Before You Have Accepted", "offer_extension"],
  [25, "25. Thanking Someone Who Helped You Get the Offer", "thank_helper_offer"],
  [26, "26. Keeping in Touch", "keep_in_touch"],
  [27, "27. Reply When They Agree to a Call", "call_scheduling"],
  [28, "28. Checking In After an Interview", "interview_check_in"],
  [29, "29. Thank You After an Info Session or Speaker Event", "thank_you_event"],
  [30, "30. Emailing a Recruiting Inbox for the First Time", "recruiting_inbox"],
  [31, "31. Closing the Loop With a Referrer", "close_loop_referrer"],
  [32, "32. Thank You Notes in Awkward Situations", ["thank_you_chat", "thank_you_chat", "thank_you_interview"]],
  [33, "33. Cold Emails With Informal Referrals", "cold_referral"],
  [34, "34. Cold Emails to a Non-Alum: Two More Ways You Found Them", "cold_not_alum"],
  [35, "35. Two Offer Situations That Get Handled Clumsily", ["accept_offer", "decline_offer"]],
  [36, "36. Asking a Contact to Connect You at a Different Firm", "referral_ask"],
];

const partI = lines.map((l, i) => (l.startsWith("Part I. Filling Out the Thin Types") ? i : -1)).filter((i) => i >= 0);
let cursor = partI[1];
const starts = SECTIONS.map(([n, title]) => {
  const i = lines.findIndex((l, idx) => idx > cursor && l.startsWith(title));
  if (i < 0) throw new Error(`section ${n} not found`);
  cursor = i;
  return i;
});

const W = 116;
const EXAMPLE_WORDS = ["One", "Two", "Three", "Four", "Five"];
// Paragraph ends checked by hand against the PDF, where the width rule guesses wrong.
const FORCE_BREAK = ["asked this fall.", "I will be straightforward:"];
// Line ends that look like paragraph ends but continue.
const FORCE_JOIN = [];
const isList = (l) => /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), /.test(l) || /^\d\. /.test(l);
const review = [];
const out = {};

SECTIONS.forEach(([n, , types], si) => {
  const end = si + 1 < starts.length ? starts[si + 1] : lines.length;
  const sec = lines.slice(starts[si], end);
  let exampleIndex = 0;
  for (let i = 0; i < sec.length; i++) {
    if (!EXAMPLE_WORDS.includes(sec[i])) continue;
    const typeId = Array.isArray(types) ? types[exampleIndex] : types;
    exampleIndex++;
    if (!typeId) throw new Error(`section ${n}: more examples than mapped types`);
    let j = i + 1;
    let note;
    if (sec[j].startsWith("(")) {
      note = sec[j];
      while (!note.endsWith(")")) note += " " + sec[++j];
      note = note.slice(1, -1);
      j++;
    }
    let typed;
    if (sec[j].startsWith("What the student typed:")) {
      typed = sec[j];
      while (!typed.endsWith("”")) typed += " " + sec[++j];
      typed = typed.replace(/^What the student typed:\s*/, "");
      j++;
    }
    if (!sec[j].startsWith("Subject: ")) throw new Error(`section ${n} example ${sec[i]}: no subject (${sec[j]})`);
    const subject = sec[j].slice("Subject: ".length);
    const greeting = sec[j + 1];
    const bestIdx = sec.findIndex((l, k) => k > j + 1 && l === "Best,");
    // A signature ends at "[phone number]", or right at "Best," when the
    // student's mail client adds it (the next line is another example or heading).
    const signature = ["Best,"];
    for (let k = bestIdx + 1; k < sec.length; k++) {
      const l = sec[k];
      if (EXAMPLE_WORDS.includes(l) || l.startsWith("Part ") || /^\d+\. [A-Z]/.test(l)) break;
      signature.push(l);
      if (l === "[phone number]") break;
    }
    const bodyLines = sec.slice(j + 2, bestIdx);

    const blocks = [];
    let para = [];
    let list = [];
    const flushPara = () => para.length && (blocks.push(para.join(" ")), (para = []));
    const flushList = () => list.length && (blocks.push(list.join("\n")), (list = []));
    bodyLines.forEach((l, k) => {
      const next = bodyLines[k + 1];
      if (isList(l)) {
        flushPara();
        list.push(l);
        if (!next || !isList(next)) flushList();
        return;
      }
      para.push(l);
      if (!next) return flushPara();
      const terminal = /[.!?:”")]$/.test(l);
      const nextWord = next.split(" ")[0];
      const fits = l.length + 1 + nextWord.length <= W;
      const breakHere = isList(next)
        ? l.endsWith(":") || terminal
        : !FORCE_JOIN.some((s) => l.endsWith(s)) && (FORCE_BREAK.some((s) => l.endsWith(s)) || (terminal && fits));
      if (terminal && l.length >= 84) {
        review.push(`[s${n} ${sec[i]} ${typeId}] ${breakHere ? "BREAK" : "join "} len=${l.length} nextWord=${nextWord.length} | ${l.slice(-45)} || ${next.slice(0, 30)}`);
      }
      if (breakHere) flushPara();
    });
    flushPara();
    flushList();

    const body = [greeting, ...blocks].join("\n\n") + "\n\n" + signature.join("\n");
    const fullNote = [note, typed && `what the student typed: ${typed}`].filter(Boolean).join("; ");
    (out[typeId] ??= []).push({ section: n, ...(fullNote ? { note: fullNote } : {}), subject, body });
  }
  const expected = Array.isArray(types) ? types.length : null;
  if (expected !== null && exampleIndex !== expected) throw new Error(`section ${n}: ${exampleIndex} examples, ${expected} types`);
});

writeFileSync(S + "v4-examples.json", JSON.stringify(out, null, 2) + "\n");
writeFileSync(S + "v4-review.txt", review.join("\n") + "\n");
let total = 0;
for (const [k, v] of Object.entries(out)) {
  total += v.length;
  console.log(k.padEnd(28), v.map((e) => e.section).join(","));
}
console.log("examples:", total, "review lines:", review.length);
