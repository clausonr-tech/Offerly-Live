// Category 3: a format step telling the drafter to do something the house or
// voice rules tell it (and the reviewer) to undo. The pipeline pays a model
// call to fight itself.
import { EMAIL_TYPES } from "../../../src/lib/draft-templates";
import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";

// The four courtesy lines VOICE_RULES bans outright, and the invented-specific
// HOUSE_RULES bans by name.
const BANNED: { what: string; inOutput: RegExp }[] = [
  { what: 'VOICE_RULES bans "happy to work around your schedule"', inOutput: /work(ing)? around your schedule/i },
  { what: 'VOICE_RULES bans "I attached my resume for your reference"', inOutput: /resume (is attached )?for (your )?reference|attached my resume for your reference/i },
  { what: 'VOICE_RULES bans "I look forward to hearing from you"', inOutput: /look forward to hearing from you/i },
  { what: 'VOICE_RULES bans "please do not hesitate to reach out"', inOutput: /do not hesitate|don't hesitate/i },
  { what: 'VOICE_RULES bans the pleasantry opener as a default', inOutput: /I hope (you are|you're|this email finds|the semester|the months|your week)/i },
  { what: 'HOUSE_RULES bans "last week" as an invented specific', inOutput: /\blast week\b/i },
  { what: 'VOICE_RULES bans throat-clearing "I wanted to follow up / reach out"', inOutput: /I (just )?wanted to (follow up|reach out)/i },
];

console.log("A. Format STEPS that instruct a banned courtesy line");
for (const t of EMAIL_TYPES)
  for (const s of t.format)
    if (/flexible and will work around their schedule|Note your flexibility/i.test(s)) console.log(`  ${t.id}: ${s}`);

console.log("\nB. The same lines in the EXAMPLES each type is shown (read 2026-10-12; email-examples* is being edited by another agent)");
for (const b of BANNED) {
  const hits: string[] = [];
  for (const t of EMAIL_TYPES) {
    if (t.id === "custom") continue;
    const n = ((EMAIL_EXAMPLES as Record<string, { body: string }[]>)[t.id] ?? []).filter((e) => b.inOutput.test(e.body)).length;
    if (n) hits.push(`${t.id}:${n}`);
  }
  const total = hits.reduce((a, h) => a + Number(h.split(":")[1]), 0);
  console.log(`  ${total.toString().padStart(3)} examples  ${b.what}`);
  if (hits.length) console.log(`        ${hits.join("  ")}`);
}
const all = EMAIL_TYPES.filter((t) => t.id !== "custom").flatMap((t) => (EMAIL_EXAMPLES as Record<string, { body: string }[]>)[t.id] ?? []);
console.log(`\n  (out of ${all.length} example emails in total)`);

console.log("\nC. '[phone number]' in example signatures, which HOUSE_RULES bans by name");
console.log(`  ${all.filter((e) => /\[phone number\]/.test(e.body)).length} of ${all.length} examples end on a literal [phone number] line`);
