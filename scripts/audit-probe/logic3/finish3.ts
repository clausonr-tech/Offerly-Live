import { finishDraft, type DraftPromptInput } from "@/lib/draft-prompt";
const INPUT = {
  type: "cold_email", contactName: "Rachel Stein", studentName: "Maya Okafor",
  studentSchool: "Duke University", studentSchoolEmail: "maya.okafor@duke.edu",
  studentPhone: "9195550142", studentGradYear: 2029, now: new Date("2026-09-20T12:00:00"),
} as DraftPromptInput;
console.log("closing the model wrote".padEnd(40), "model's closing still in the final body?");
for (const close of [
  "Best, Maya Okafor", "Best, Maya A. Okafor", "Best regards, Maya Okafor", "Sincerely",
  "Thank you so much,", "Thanks so much,", "Looking forward to hearing from you,", "Gratefully,",
  "Warm wishes,", "All my best,", "Best,Maya", "Best, Maya Okafor-Smith", "Best , Maya",
  "Best wishes,", "Kind regards,", "Thanks,", "Thank you,", "Many thanks,", "With gratitude,",
  "Appreciatively,", "Respectfully yours,", "Yours sincerely,", "Cheers, Maya",
]) {
  const out = finishDraft(INPUT, { subject: "Hi", body: `Thank you for the time.\n\n${close}\nMaya Okafor`, connectionUsed: null, gaps: [] });
  const dup = out.body.includes(close) && close !== "Best,";
  console.log(JSON.stringify(close).padEnd(40), dup ? "YES - TWO SIGN-OFFS" : "no  (cut correctly)");
}
