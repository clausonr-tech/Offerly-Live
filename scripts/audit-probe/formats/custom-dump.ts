// What a `custom` draft's prompt actually contains. formatBlock dumps all 40
// other formats into it, with none of their promptNotes - so every escape
// clause that lives in a promptNote is absent from the custom path.
import { buildDraftPrompt } from "../../../src/lib/draft-prompt";
const { system, userText } = buildDraftPrompt({
  studentName: "Alex Rivera", studentSchool: "Ridgemont University", studentGradYear: 2029,
  studentMajor: "Economics", contactName: "Rachel Stein", contactFirm: "Halcombe Partners",
  type: "custom", purpose: "ask about their summer analyst program", boxIds: ["custom.describe"],
});
const whole = system + "\n" + userText;
console.log(`custom prompt: ${whole.length} chars, ${whole.split("\n").length} lines`);
for (const pat of [/graduation date/gi, /\[original subject line\]/g, /Professor \[Last name\]/g, /\[Role\] Interview/g, /\[your available times\]/g]) {
  const hits = [...whole.matchAll(pat)];
  console.log(`  ${String(pat)}  x${hits.length}`);
  for (const h of hits) console.log(`      ...${whole.slice(Math.max(0, h.index! - 70), h.index! + 60).replace(/\n/g, " | ")}...`);
}
console.log("\ngraduation-year escape clause present in the custom prompt?",
  /never ask for a graduation month|give just the year|holds only a year/i.test(whole));
