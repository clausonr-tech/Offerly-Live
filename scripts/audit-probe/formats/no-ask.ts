// Four thank-you types let the student choose "no ask". Three of them carry a
// note telling the drafter what to write instead; thank_you_event does not, and
// its format step demands an ask unconditionally.
import { buildDraftPrompt } from "../../../src/lib/draft-prompt";
import { EMAIL_TYPES } from "../../../src/lib/draft-templates";
const CASES = [
  { id: "thank_you_event" as const, box: "thanks.event", answers: [["The session - name it so they can place it", "the Halcombe info session at Calloway Hall"], ["The specific point from their remarks that stuck with the student", "analysts who ask twice"], ["What to ask for at the end", "Nothing, just thanks"]] },
  { id: "thank_you_recruiter_session" as const, box: "thanks.session", answers: [["The session the recruiter ran", "the Halyard Point session"], ["A specific thing the recruiter explained", "how an application moves"]] },
  { id: "thank_you_offered_help" as const, box: "thanks.helped", answers: [["What the recipient offered", "Nothing - the chat went as far as it will"], ["A specific thing from the conversation", "following the customer, not the sector"]] },
  { id: "thank_you_chat" as const, box: "thanks.chat", answers: [] as string[][] },
];
for (const c of CASES) {
  const t = EMAIL_TYPES.find((x) => x.id === c.id)!;
  const { userText } = buildDraftPrompt({
    studentName: "Alex Rivera", studentSchool: "Ridgemont University", studentGradYear: 2029,
    contactName: "Rachel Stein", contactFirm: "Halcombe Partners", type: c.id, boxIds: [c.box],
    brief: { fieldAnswers: c.answers.map(([prompt, value]) => ({ prompt, value })), nextStepAsk: c.id === "thank_you_chat" ? "none" : undefined },
  });
  console.log(`\n### ${c.id} with "no ask" chosen`);
  console.log("  format steps that demand an ask:");
  for (const s of t.format) if (/^Ask\b|\bask about next steps|or ask for a short call|plus the ask/i.test(s)) console.log(`    ! ${s}`);
  const relief = userText.split("\n").filter((l) => /no ask|isn't asking for anything|just wanted to say thank|just wanted to say|Nothing, just thanks|With no question/i.test(l));
  console.log("  lines that say an ask is optional / absent:");
  if (relief.length === 0) console.log("    (NONE)");
  for (const l of relief) console.log(`    + ${l.trim()}`);
}
