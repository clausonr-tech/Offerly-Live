// FORMAT-AUDIT probe. Machine-checks what can be machine-checked about the 41
// `format` bodies in src/lib/draft-templates.ts. Read-only; prints a report.
//
//   npx tsx scripts/audit-probe/formats/probe.ts
//
// Six checks, in the order the audit ranks them:
//   1. bracket   - a literal [placeholder] inside a format step or promptNote
//   2. facts     - a format step demanding a fact no field / profile column holds
//   3. quotes    - a format step that quotes a sentence (it teaches that sentence)
//   4. ceiling   - maxWords against the type's own examples and its step count
//   5. fieldrefs - a step or note naming a field the type does not have
//   6. reach     - a type no picker box can select
import { EMAIL_TYPES, type EmailType } from "../../../src/lib/draft-templates";
import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";
import { OCCASIONS } from "../../../src/lib/draft-occasions";

const only = process.argv[2];
const run = (name: string) => !only || only === name;
const steps = (t: EmailType) => t.format;
const allText = (t: EmailType) => [...t.format, ...(t.promptNotes ?? [])];

// ---------------------------------------------------------------- 1. bracket
// The graduation-month bug shipped as "[graduation month]" in 12 of 28 emails.
// A literal bracket in the prompt is the drafter being shown that output.
if (run("bracket")) {
  console.log("\n=== 1. LITERAL [placeholders] IN THE PROMPT TEXT");
  let n = 0;
  for (const t of EMAIL_TYPES) {
    for (const s of t.format) for (const m of s.matchAll(/\[[^\]]{1,40}\]/g)) { console.log(`  ${t.id}  format   ${m[0]}  -- ${s.slice(0, 90)}`); n++; }
    for (const s of t.promptNotes ?? []) for (const m of s.matchAll(/\[[^\]]{1,40}\]/g)) { console.log(`  ${t.id}  note     ${m[0]}  -- ${s.slice(0, 90)}`); n++; }
    for (const f of t.fields ?? []) for (const m of f.prompt.matchAll(/\[[^\]]{1,40}\]/g)) { console.log(`  ${t.id}  field    ${m[0]}  -- ${f.name}`); n++; }
  }
  console.log(`  ${n} literal bracketed placeholders in format steps, notes and field prompts`);
}

// ------------------------------------------------------------------ 2. facts
// Facts a step can demand, and where the app could possibly get each one.
// `holders` are the DraftPromptInput keys / shared brief keys that supply it;
// a type also satisfies a demand with one of its own fields.
const FACTS: { id: string; pattern: RegExp; holders: string[] }[] = [
  { id: "graduation date/month", pattern: /graduation date|graduation month|\bgrad(uation)? (date|month)\b/i, holders: [] },
  { id: "class year", pattern: /class year|year in school/i, holders: ["studentGradYear"] },
  { id: "phone number", pattern: /phone number|your number/i, holders: ["studentPhone"] },
  { id: "student major", pattern: /\bmajor\b/i, holders: ["studentMajor"] },
  { id: "student school", pattern: /\bschool\b/i, holders: ["studentSchool"] },
  { id: "resume", pattern: /\bresume\b/i, holders: ["studentResumeSummary", "hasResumePdf"] },
  { id: "recipient last name", pattern: /\[?last name\]?/i, holders: ["contactName"] },
  { id: "recipient team/group", pattern: /\btheir team\b|\btheir group\b/i, holders: ["contactGroup", "contactRole"] },
  { id: "time zone", pattern: /time zone/i, holders: ["timeZone(field)"] },
  { id: "requisition number", pattern: /requisition number|\breq(uisition)? ?#/i, holders: [] },
  { id: "start date", pattern: /start date/i, holders: [] },
  { id: "the deadline", pattern: /\bdeadline\b/i, holders: [] },
  { id: "firm name", pattern: /\bfirm\b/i, holders: ["contactFirm"] },
];
// Shared brief questions (draft-occasions) a type may rely on instead of a field.
const SHARED = new Set(["originalSubject", "originalDate", "originalAsk", "followUp1Date", "financeInterest", "wantToLearn", "specificReason", "meetingWhen", "conversationDetails", "nextStepAsk", "introName", "introReason", "interviewTeam", "personalConnection"]);
if (run("facts")) {
  console.log("\n=== 2. FACTS A FORMAT STEP DEMANDS, AGAINST WHAT CAN SUPPLY THEM");
  for (const t of EMAIL_TYPES) {
    const own = (t.fields ?? []).map((f) => `${f.name} ${f.label} ${f.prompt}`.toLowerCase()).join(" | ");
    for (const f of FACTS) {
      const hit = steps(t).find((s) => f.pattern.test(s));
      if (!hit) continue;
      const byField = f.pattern.test(own);
      const byProfile = f.holders.length > 0;
      if (byField || byProfile) continue;
      const escaped = allText(t).some((s) => /never (ask|leave)|isn't given|if (the|no|none)|leave (it|that sentence) out|no placeholder/i.test(s) && f.pattern.test(s));
      console.log(`  ${escaped ? "SOFT" : "HARD"}  ${t.id}  wants "${f.id}"  -- step: ${hit.slice(0, 100)}`);
    }
  }
  console.log("  HARD = no field, no profile column, no escape clause anywhere in the type.");
}

// ----------------------------------------------------------------- 3. quotes
// MEASURED twice in this project: a demonstration beats an instruction. Any
// sentence a format step quotes is a sentence the drafter is being taught.
if (run("quotes")) {
  console.log("\n=== 3. FORMAT STEPS THAT QUOTE A PHRASING");
  let n = 0;
  for (const t of EMAIL_TYPES)
    for (const s of t.format)
      for (const m of s.matchAll(/["“]([^"”]{12,200})["”]/g)) {
        const words = m[1].trim().split(/\s+/).length;
        if (words < 3) continue;
        console.log(`  ${t.id}  (${words}w)  "${m[1]}"`); n++;
      }
  console.log(`  ${n} quoted phrasings inside format steps`);
}

// ---------------------------------------------------------------- 4. ceiling
const SIGN_OFF = /^\s*(Best|Sincerely|Thank you|Thanks|Warmly|Regards|All the best)[,.]?\s*$/i;
function bodyWords(body: string): number {
  const lines = body.split("\n");
  const i = lines.findIndex((l) => SIGN_OFF.test(l));
  return (i === -1 ? lines : lines.slice(0, i)).join(" ").trim().split(/\s+/).filter(Boolean).length;
}
if (run("ceiling")) {
  console.log("\n=== 4. maxWords AGAINST THE TYPE'S OWN EXAMPLES AND ITS STEP COUNT");
  console.log("  type                           ceil  steps  w/step  ex   min  med  max  over");
  const rows: { t: EmailType; max: number; med: number; min: number; n: number; content: number }[] = [];
  for (const t of EMAIL_TYPES) {
    if (t.id === "custom") continue;
    const ex = (EMAIL_EXAMPLES[t.id] ?? []).map((e) => bodyWords(e.body)).sort((a, b) => a - b);
    // The last step of most formats is a rule about the email, not a step in it.
    const content = t.format.filter((s) => !/^(The more concise|The specific detail|Without a shared school|Only use someone|Shorter and more formal|They met dozens|Never ask a recruiter|Don't restate|Mean it when|An inbox gets|Two check-ins|Silence from|One question, not two|Always include the time zone|Never reschedule|More formal than|When you come back|A redirect is|Interviewers compare|A recruiter screen|No rapport|If an exam|Four or five sentences|Ask once|If nobody helped|Never criticize|People who help|If the timeline|Never list someone|Genuine and kind|The whole value|Don't ask again|Recruiters organize|The only goal|The referral does|Never send two|Never ask someone|Shorter than your)/i.test(s)).length;
    rows.push({ t, max: ex.at(-1) ?? 0, med: ex[Math.floor(ex.length / 2)] ?? 0, min: ex[0] ?? 0, n: ex.length, content });
    const over = ex.filter((w) => w > t.maxWords).length;
    console.log(
      `  ${t.id.padEnd(30)} ${String(t.maxWords).padStart(4)}  ${String(t.format.length).padStart(5)}  ${String(Math.floor(t.maxWords / Math.max(1, content))).padStart(6)}  ${String(ex.length).padStart(3)}  ${String(ex[0] ?? 0).padStart(4)} ${String(rows.at(-1)!.med).padStart(4)} ${String(ex.at(-1) ?? 0).padStart(4)}  ${over > 0 ? `${over} EXAMPLE(S) OVER` : ""}`,
    );
  }
  console.log("\n  Tightest ceilings by words-per-content-step:");
  for (const r of rows.sort((a, b) => a.t.maxWords / Math.max(1, a.content) - b.t.maxWords / Math.max(1, b.content)).slice(0, 8))
    console.log(`    ${r.t.id.padEnd(30)} ${r.t.maxWords}w / ${r.content} steps = ${(r.t.maxWords / r.content).toFixed(1)} w/step   longest example ${r.max}w`);
  console.log("\n  Ceiling vs longest example (headroom):");
  for (const r of rows.sort((a, b) => a.t.maxWords - a.max - (b.t.maxWords - b.max)).slice(0, 8))
    console.log(`    ${r.t.id.padEnd(30)} ceiling ${r.t.maxWords}, longest example ${r.max} (${r.t.maxWords - r.max >= 0 ? "+" : ""}${r.t.maxWords - r.max})`);
}

// -------------------------------------------------------------- 5. fieldrefs
if (run("fieldrefs")) {
  console.log("\n=== 5. STEPS/NOTES NAMING A FIELD-LIKE THING THE TYPE DOES NOT HAVE");
  for (const t of EMAIL_TYPES) {
    const names = new Set([...(t.fields ?? []).map((f) => f.name), ...SHARED]);
    for (const s of allText(t))
      for (const m of s.matchAll(/`([A-Za-z][A-Za-z0-9]{2,})`/g))
        if (!names.has(m[1]) && !["notesForStudent", "gaps", "connectionUsed", "plan", "subject", "body", "sentences", "people"].includes(m[1]))
          console.log(`  ${t.id}: \`${m[1]}\` -- ${s.slice(0, 80)}`);
  }
  console.log("  (backtick references only; prose references are read by hand)");
}

// ------------------------------------------------------------------ 6. reach
if (run("reach")) {
  console.log("\n=== 6. REACHABILITY");
  const reachable = new Set(OCCASIONS.flatMap((o) => o.sections.flatMap((s) => s.boxes.map((b) => b.typeId))));
  const dead = EMAIL_TYPES.filter((t) => !reachable.has(t.id)).map((t) => t.id);
  console.log(dead.length ? `  UNREACHABLE: ${dead.join(", ")}` : `  all ${EMAIL_TYPES.length} types reachable from the picker`);
  const noExamples = EMAIL_TYPES.filter((t) => t.id !== "custom" && (EMAIL_EXAMPLES[t.id] ?? []).length === 0).map((t) => t.id);
  console.log(noExamples.length ? `  NO EXAMPLES: ${noExamples.join(", ")}` : "  every non-custom type has examples");
}
