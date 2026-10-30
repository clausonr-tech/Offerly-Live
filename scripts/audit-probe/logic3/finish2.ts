import { finishDraft, type DraftPromptInput } from "@/lib/draft-prompt";
const INPUT = {
  type: "cold_email", contactName: "Rachel Stein", studentName: "Maya Okafor",
  studentSchool: "Duke University", studentSchoolEmail: "maya.okafor@duke.edu",
  studentPhone: "9195550142", studentGradYear: 2029, now: new Date("2026-09-20T12:00:00"),
} as DraftPromptInput;
const run = (label: string, body: string) => {
  const out = finishDraft(INPUT, { subject: "Hi", body, connectionUsed: null, gaps: [] });
  const n = out.body.split("\n").filter((l) => /^(best|with appreciation|sincerely|warm regards|looking forward|gratefully|thanks again)\b/i.test(l.trim())).length;
  console.log(`\n### ${label}  -> ${n} sign-off line(s)${n > 1 ? "  *** TWO SIGN-OFFS ***" : ""}`);
  console.log(out.body.split("\n").map((l) => "   | " + l).join("\n"));
};

// Mid-body line that the em-dash rewrite turns into a CLOSING match: everything
// after it is deleted.
run("L mid-body 'Thanks again — Maya' eats the rest of the email", [
  "Rachel,",
  "",
  "Thanks again — Maya",
  "",
  "I had two questions. First, when does the sophomore programme open?",
  "Second, does it feed the summer analyst class?",
  "",
  "Best,",
  "Maya Okafor",
].join("\n"));

for (const close of [
  "Best, Maya A. Okafor",
  "Best regards, Maya Okafor",
  "Sincerely",
  "Thank you so much,",
  "Looking forward to hearing from you,",
  "Gratefully,",
  "Warm wishes,",
  "All my best,",
  "Best,Maya",
  "Best, Maya Okafor-Smith",
  "Best , Maya",
]) {
  run(`closing = ${JSON.stringify(close)}`, `Thank you for the time.\n\n${close}\nMaya Okafor`);
}
