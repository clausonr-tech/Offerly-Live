// INPUT-1 probe 3: the brief handoff, preset merge order, and prompt-level
// duplication. Replays runGenerateDraft's form-reading logic verbatim (no DB,
// no model) and builds the real prompt.
import { OCCASIONS, resolveSituation, situationQuestions, situationTypes, answerFor, aliasesOf, ASK_QUESTIONS, FOUND_QUESTIONS, boxById, type Situation } from "../../../src/lib/draft-occasions";
import { EMAIL_TYPES, emailTypeById } from "../../../src/lib/draft-templates";
import { buildDraftPrompt, type DraftBrief } from "../../../src/lib/draft-prompt";

const valid: { occ: string; boxes: string[]; s: Situation }[] = [];
for (const o of OCCASIONS) {
  const ids = o.sections.flatMap((s) => s.boxes).map((b) => b.id);
  for (let m = 1; m < 2 ** ids.length; m++) {
    const pick = ids.filter((_, i) => m & (1 << i));
    const r = resolveSituation(o.id, pick);
    if (!("error" in r)) valid.push({ occ: o.id, boxes: pick, s: r });
  }
}

// ------------------------------------------------- A. ASK_/FOUND_ dead entries
const fieldNames = new Set(EMAIL_TYPES.flatMap((t) => (t.fields ?? []).map((f) => f.name)));
const briefNames = new Set(["financeInterest","wantToLearn","specificReason","originalSubject","originalDate","originalAsk","followUp1Date","meetingWhen","nextStepAsk","introName","introReason","conversationDetails","interviewTeam","personalConnection"]);
console.log("## A. ASK_QUESTIONS / FOUND_QUESTIONS membership");
for (const n of ASK_QUESTIONS) console.log(`  ASK  ${n.padEnd(14)} ${fieldNames.has(n) ? "type field" : briefNames.has(n) ? "brief question" : "!! NO SUCH QUESTION"}`);
for (const n of FOUND_QUESTIONS) console.log(`  FOUND ${n.padEnd(13)} ${fieldNames.has(n) ? "type field" : briefNames.has(n) ? "brief question" : "!! NO SUCH QUESTION"}`);

// --------------------------------------------- B. preset merge order, measured
console.log("\n## B. Which box's preset wins when two boxes preset the same question?");
const collisions = valid.filter((c) => {
  const keys = [c.s.lead, ...c.s.also].flatMap((b) => Object.keys(b.presets ?? {}));
  return keys.length !== new Set(keys).size;
});
console.log(`  combinations in the shipped data where two checked boxes preset the same question: ${collisions.length}`);
// Measured proof of the merge rule, by giving two real boxes a colliding preset
// in memory (BOXES holds these same objects).
const a = boxById("stay.update")!, b = boxById("stay.congrats")!;
const saveA = a.presets, saveB = b.presets;
(a as { presets?: Record<string,string> }).presets = { collide: "from-stay.update" };
(b as { presets?: Record<string,string> }).presets = { collide: "from-stay.congrats" };
const merged = resolveSituation("stay", ["stay.update", "stay.congrats"]);
if (!("error" in merged)) {
  console.log(`  order (strongest first): ${[merged.lead, ...merged.also].map((x) => x.id).join(" > ")}`);
  console.log(`  presets.collide = ${JSON.stringify(merged.presets.collide)}  -> the ${merged.presets.collide === "from-stay.update" ? "LEAD (strongest)" : "WEAKEST"} box wins`);
}
const reversed = resolveSituation("stay", ["stay.congrats", "stay.update"]);
if (!("error" in reversed)) console.log(`  same with the ids submitted in the other order: ${JSON.stringify(reversed.presets.collide)}`);
(a as { presets?: Record<string,string> }).presets = saveA;
(b as { presets?: Record<string,string> }).presets = saveB;

// ------------------------------------------- C. "{recipient}" substitution map
console.log("\n## C. \"{recipient}\" presets");
for (const bx of OCCASIONS.flatMap((o) => o.sections.flatMap((s) => s.boxes))) {
  for (const [k, v] of Object.entries(bx.presets ?? {})) if (v === "{recipient}") {
    const owners = EMAIL_TYPES.filter((t) => (t.fields ?? []).some((f) => f.name === k)).map((t) => t.id);
    console.log(`  ${bx.id}.presets.${k} = "{recipient}"  field lives on: ${owners.join("/") || "!! NO FIELD"}  box typeId=${bx.typeId}`);
  }
}
// is "{recipient}" ever compared as a showWhen value, or emitted raw anywhere?
const recipientPresetKeys = new Set(OCCASIONS.flatMap((o)=>o.sections.flatMap((s)=>s.boxes)).flatMap((bx)=>Object.entries(bx.presets??{}).filter(([,v])=>v==="{recipient}").map(([k])=>k)));
const showWhenOn = EMAIL_TYPES.flatMap((t)=>(t.fields??[]).filter((f)=>f.showWhen && recipientPresetKeys.has(f.showWhen.field)).map((f)=>`${t.id}.${f.name} depends on ${f.showWhen!.field}`));
console.log(`  conditional questions controlled by a "{recipient}" preset (would compare against the literal token): ${showWhenOn.join(", ") || "none"}`);

// ------------------------- D. replay runGenerateDraft's field reading, no DB
type Replay = { brief: DraftBrief; typeFields: { name: string; prompt: string; label: string; value: string }[]; error?: string };
function replay(c: { s: Situation }, answers: Record<string, string>, contactName = "Jordan Blake"): Replay {
  const field = (n: string) => { const v = (answers[n] ?? "").trim(); return v || undefined; };
  const oneOf = <T extends string>(n: string, o: readonly T[]) => { const v = field(n); return o.includes(v as T) ? (v as T) : null; };
  const brief: DraftBrief = {
    financeInterest: field("financeInterest"), wantToLearn: field("wantToLearn"), specificReason: field("specificReason"),
    threadSubject: field("threadSubject"), originalSubject: field("originalSubject"), originalDate: field("originalDate"),
    originalAsk: field("originalAsk"), followUp1Date: field("followUp1Date"), meetingWhen: field("meetingWhen"),
    conversationDetails: answerFor("conversationDetails", field),
    nextStepAsk: oneOf("nextStepAsk", ["who_else", "intro", "none"] as const),
    introName: field("introName"), introReason: field("introReason"),
    interviewTeam: field("interviewTeam"), personalConnection: field("personalConnection"),
  };
  const typeFields: Replay["typeFields"] = [];
  for (const q of situationQuestions(c.s, (n) => c.s.presets[n] ?? field(n))) {
    if (!q.prompt) continue;
    const raw = answerFor(q.name, field);
    if (!raw) { if (q.required) return { brief, typeFields, error: `Add "${q.label}" to draft this email.` }; continue; }
    typeFields.push({ name: q.name, prompt: q.prompt, label: q.label, value: q.options?.find((o) => o.value === raw)?.label ?? raw });
  }
  const types = situationTypes(c.s);
  for (const t of types) for (const f of t.fields ?? []) {
    const preset = c.s.presets[f.name];
    if (!preset || typeFields.some((tf) => tf.name === f.name)) continue;
    typeFields.push({ name: f.name, prompt: f.prompt, label: f.label, value: preset === "{recipient}" ? contactName : (f.options?.find((o) => o.value === preset)?.label ?? preset) });
  }
  brief.fieldAnswers = typeFields.map(({ prompt, value }) => ({ prompt, value }));
  return { brief, typeFields };
}

console.log("\n## D. Every question answered -> does any answer reach the model twice?");
let dupCount = 0;
const dupDetail: string[] = [];
for (const c of valid) {
  const qs = situationQuestions(c.s, (n) => c.s.presets[n] ?? undefined);
  const answers: Record<string, string> = {};
  qs.forEach((q, i) => { answers[q.name] = q.kind === "select" ? (q.options?.[0]?.value ?? `A${i}`) : `ANSWER_${q.name}`; });
  const r = replay(c, answers);
  if (r.error) { console.log(`  !! ${c.occ}[${c.boxes.join("+")}] every visible question answered and the server still errors: ${r.error}`); continue; }
  // an answer carried both in fieldAnswers and in a brief line
  const briefUsed = Object.entries(r.brief).filter(([k, v]) => k !== "fieldAnswers" && typeof v === "string") as [string, string][];
  for (const [k, v] of briefUsed) {
    const also = r.typeFields.find((tf) => tf.value === v);
    if (also) { dupCount++; dupDetail.push(`${c.occ}[${c.boxes.join("+")}]: "${v}" is in brief.${k} AND in fieldAnswers as ${also.name}`); }
  }
}
console.log(`  combinations where one typed answer lands in both the brief and fieldAnswers: ${dupCount}`);
for (const d of [...new Set(dupDetail.map((x) => x.replace(/ANSWER_/g, "")))].slice(0, 20)) console.log(`     ${d}`);

// ----------------------------- E. the same text twice in the real prompt body
console.log("\n## E. The same answer twice in the built prompt (real buildDraftPrompt)");
const probe = ["thanks|thanks.chat+thanks.helped", "thanks|thanks.chat", "thanks|thanks.interview+thanks.helped", "thanks|thanks.helped+thanks.event"];
for (const key of probe) {
  const [occ, bx] = key.split("|");
  const c = valid.find((v) => v.occ === occ && v.boxes.join("+") === bx);
  if (!c) { console.log(`  (no combination ${key})`); continue; }
  const qs = situationQuestions(c.s, (n) => c.s.presets[n] ?? undefined);
  const answers: Record<string, string> = {};
  qs.forEach((q) => { answers[q.name] = q.kind === "select" ? (q.options?.[0]?.value ?? "") : `MARKER_${q.name}`; });
  const r = replay(c, answers);
  const types = situationTypes(c.s);
  const built = buildDraftPrompt({
    studentName: "Sam Rivera", studentSchool: "Penn", contactName: "Jordan Blake", contactFirm: "Evercore",
    type: types[0].id, alsoTypes: types.slice(1).map((t) => t.id), situationSummary: c.s.summary,
    boxIds: [c.s.lead, ...c.s.also].map((b) => b.id), brief: r.brief, purpose: null,
  } as never);
  const text = built.system + "\n" + built.userText;
  const markers = [...new Set(Object.keys(answers).map((n) => `MARKER_${n}`))];
  const twice = markers.filter((m) => (text.match(new RegExp(m, "g")) ?? []).length > 1);
  console.log(`  ${key} types=${types.map((t) => t.id).join("/")}`);
  for (const m of twice) {
    const lines = text.split("\n").filter((l) => l.includes(m));
    console.log(`     "${m.replace("MARKER_", "")}" appears ${(text.match(new RegExp(m, "g")) ?? []).length}x:`);
    for (const l of lines) console.log(`         ${l.trim().slice(0, 150)}`);
  }
  if (!twice.length) console.log("     no answer repeated");
}

// ------------------------------------------- F. redirect_sequence question set
console.log("\n## F. redirect_sequence (the one type reached from three different boxes)");
for (const id of ["first.pointed", "reply.pointed", "stay.redirected"]) {
  const bx = boxById(id)!;
  const occ = OCCASIONS.find((o) => o.sections.some((s) => s.boxes.some((b) => b.id === id)))!;
  const r = resolveSituation(occ.id, [id]);
  if ("error" in r) continue;
  const qs = situationQuestions(r, (n) => r.presets[n] ?? undefined);
  console.log(`  ${id} presets=${JSON.stringify(r.presets)}  -> ${qs.length} questions`);
  for (const q of qs) console.log(`      ${q.required ? "*" : " "} ${q.name.padEnd(18)} ${JSON.stringify(q.label)}`);
}
