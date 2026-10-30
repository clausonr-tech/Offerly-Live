// An OPTIONAL field (required !== true, and not hidden by a branch) that an
// unconditional numbered step demands anyway, with no note saying what to do
// when it is blank. GAP_RULES then puts a bracket in the body - the
// graduation-month failure, reached through a blank form field instead of a
// missing column.
import { EMAIL_TYPES } from "../../../src/lib/draft-templates";
const ESCAPE = /if (no|none|nothing|the|a |it |they |there)|isn't given|with no |leave (it|them|that sentence) out|no placeholder|or none at all|skip/i;
let n = 0;
for (const t of EMAIL_TYPES) {
  for (const f of t.fields ?? []) {
    if (f.required || f.showWhen) continue;
    const words = (f.label + " " + (f.placeholder ?? "") + " " + f.prompt).toLowerCase().match(/[a-z]{5,}/g) ?? [];
    const step = t.format.find((s) => !/\bif\b|\bunless\b|\bor\b|optional/i.test(s) && words.filter((w) => s.toLowerCase().includes(w)).length >= 2);
    if (!step) continue;
    const covered = (t.promptNotes ?? []).some((note) => ESCAPE.test(note) && words.filter((w) => note.toLowerCase().includes(w)).length >= 1);
    console.log(`${covered ? "  ok  " : "  GAP "} ${t.id}.${f.name}  (${f.label})`);
    console.log(`         step: ${step.slice(0, 110)}`);
    if (!covered) n++;
  }
}
console.log(`\n${n} optional fields demanded by an unconditional step with no escape clause`);
