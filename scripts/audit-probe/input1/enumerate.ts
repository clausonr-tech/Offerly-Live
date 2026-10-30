// INPUT-1 audit probe: exhaustive enumeration of the FORM -> SITUATION -> BRIEF
// input path. Read-only; prints results, writes nothing into src/.
//
// Run: npx tsx scripts/audit-probe/input1/enumerate.ts
import {
  OCCASIONS,
  resolveSituation,
  boxesConflict,
  toggleBox,
  situationQuestions,
  situationTypes,
  aliasesOf,
  answerFor,
  visibleSections,
  autoFill,
  suggestions,
  QUESTION_MERGES,
  ASK_QUESTIONS,
  FOUND_QUESTIONS,
  occasionById,
  boxById,
  type Situation,
  type Question,
} from "../../../src/lib/draft-occasions";
import { EMAIL_TYPES, emailTypeById, type DraftField, type EmailType } from "../../../src/lib/draft-templates";

const out: string[] = [];
const say = (s = "") => { out.push(s); console.log(s); };

// ---------------------------------------------------------------- 0. inventory
say("## 0. Inventory");
const allBoxes = OCCASIONS.flatMap((o) => o.sections.flatMap((s) => s.boxes));
say(`occasions=${OCCASIONS.length} sections=${OCCASIONS.flatMap(o=>o.sections).length} boxes=${allBoxes.length} emailTypes=${EMAIL_TYPES.length}`);
for (const o of OCCASIONS) {
  const n = o.sections.flatMap((s) => s.boxes).length;
  say(`  ${o.id}: ${o.sections.map((s) => `${s.mode}:${s.boxes.length}`).join(" + ")} = ${n} boxes, 2^${n}=${2 ** n} subsets`);
}
const dupBoxIds = allBoxes.map(b=>b.id).filter((id,i,a)=>a.indexOf(id)!==i);
say(`duplicate box ids: ${dupBoxIds.length ? dupBoxIds.join(",") : "none"}`);

// -------------------------------------------------- 1. box -> type reachability
say("");
say("## 1. Box -> EmailType mapping");
const missingType = allBoxes.filter((b) => !emailTypeById(b.typeId));
say(`boxes whose typeId has no EmailType: ${missingType.length ? missingType.map(b=>`${b.id}->${b.typeId}`).join(", ") : "none"}`);
const reachable = new Set(allBoxes.map((b) => b.typeId));
const unreachable = EMAIL_TYPES.filter((t) => !reachable.has(t.id));
say(`EmailTypes reachable from a box: ${reachable.size}/${EMAIL_TYPES.length}`);
say(`EmailTypes NOT reachable from any box (${unreachable.length}): ${unreachable.map(t=>t.id).join(", ") || "none"}`);
const typeBoxCount = new Map<string, string[]>();
for (const b of allBoxes) typeBoxCount.set(b.typeId, [...(typeBoxCount.get(b.typeId) ?? []), b.id]);
say(`types served by >1 box: ${[...typeBoxCount].filter(([,v])=>v.length>1).map(([t,v])=>`${t}(${v.join("/")})`).join(", ")}`);

// ------------------------------------------------ 2. excludes symmetry / sanity
say("");
say("## 2. excludes table");
const badExclude: string[] = [];
const oneWay: string[] = [];
for (const b of allBoxes) {
  for (const x of b.excludes ?? []) {
    if (!boxById(x)) badExclude.push(`${b.id} excludes unknown ${x}`);
    else {
      const occOf = (id: string) => OCCASIONS.find((o) => o.sections.some((s) => s.boxes.some((bb) => bb.id === id)))!.id;
      if (occOf(b.id) !== occOf(x)) badExclude.push(`${b.id} excludes cross-occasion ${x}`);
      if (!(boxById(x)!.excludes ?? []).includes(b.id)) oneWay.push(`${b.id} -> ${x}`);
    }
  }
}
say(`broken excludes targets: ${badExclude.length ? badExclude.join("; ") : "none"}`);
say(`one-directional excludes (fine, boxesConflict is symmetric) count=${oneWay.length}`);
say(`boxesConflict symmetric for all pairs: ${allBoxes.every(a=>allBoxes.every(b=>boxesConflict(a.id,b.id)===boxesConflict(b.id,a.id))) ? "YES" : "NO"}`);
// same-section "one" boxes additionally excluded?
for (const o of OCCASIONS) for (const s of o.sections) if (s.mode === "one" && s.boxes.length > 1) {
  const pairs = s.boxes.flatMap((a,i)=>s.boxes.slice(i+1).map(b=>[a.id,b.id] as const));
  const conflicting = pairs.filter(([a,b])=>boxesConflict(a,b)).length;
  say(`  one-section "${s.title}" (${o.id}): ${conflicting}/${pairs.length} pairs also in excludes`);
}

// --------------------------------------------- 3. exhaustive subset enumeration
say("");
say("## 3. Exhaustive subset enumeration");
type Case = { occ: string; boxes: string[]; situation: Situation };
const valid: Case[] = [];
const errors = new Map<string, number>();
let subsetTotal = 0;
for (const o of OCCASIONS) {
  const boxes = o.sections.flatMap((s) => s.boxes).map((b) => b.id);
  for (let mask = 0; mask < 2 ** boxes.length; mask++) {
    const pick = boxes.filter((_, i) => mask & (1 << i));
    subsetTotal++;
    const r = resolveSituation(o.id, pick);
    if ("error" in r) errors.set(r.error, (errors.get(r.error) ?? 0) + 1);
    else valid.push({ occ: o.id, boxes: pick, situation: r });
  }
}
say(`subsets tried (incl. empty): ${subsetTotal}`);
say(`VALID combinations: ${valid.length}`);
say(`rejected: ${subsetTotal - valid.length}`);
for (const [e, n] of [...errors].sort((a, b) => b[1] - a[1])) say(`  ${n}x  ${e}`);
say("valid per occasion: " + OCCASIONS.map((o) => `${o.id}=${valid.filter((v) => v.occ === o.id).length}`).join(" "));

// reachable-from-the-UI count (non-outside recipients hide "How are you connected?")
let insideValid = 0;
for (const o of OCCASIONS) {
  const boxes = visibleSections(o, false).flatMap((s) => s.boxes).map((b) => b.id);
  for (let mask = 1; mask < 2 ** boxes.length; mask++) {
    const pick = boxes.filter((_, i) => mask & (1 << i));
    if (!("error" in resolveSituation(o.id, pick))) insideValid++;
  }
}
say(`VALID combinations reachable for a saved/matched contact (connection section hidden): ${insideValid}`);

// toggleBox can never build an invalid set
say("");
say("## 3b. toggleBox reachability + invariants");
let toggleBad = 0, toggleReached = new Set<string>();
for (const o of OCCASIONS) {
  const ids = o.sections.flatMap((s) => s.boxes).map((b) => b.id);
  // every ordered walk of length <= 3 from empty
  const walk = (cur: string[], depth: number) => {
    if (cur.length) {
      const r = resolveSituation(o.id, cur);
      if ("error" in r) { toggleBad++; if (toggleBad < 10) say(`  INVALID from toggleBox: ${o.id} ${cur.join("+")} -> ${r.error}`); }
      else toggleReached.add(`${o.id}|${[...cur].sort().join("+")}`);
    }
    if (depth === 0) return;
    for (const id of ids) walk(toggleBox(o, cur, id), depth - 1);
  };
  walk([], 3);
}
say(`toggleBox walks (depth 3) producing an invalid set: ${toggleBad}`);
say(`distinct valid sets reached by <=3 clicks: ${toggleReached.size}`);

// ------------------------------------------- 4. targeted invalid-input probing
say("");
say("## 4. Validation completeness (targeted invalid inputs)");
const show = (name: string, r: ReturnType<typeof resolveSituation>) =>
  say(`  ${name.padEnd(58)} -> ${"error" in r ? `ERROR "${r.error}"` : `SITUATION lead=${r.lead.id} also=[${r.also.map(b=>b.id).join(",")}] presets=${JSON.stringify(r.presets)}`}`);
show("occasion that does not exist", resolveSituation("nope", ["first.alum"]));
show("occasion empty string", resolveSituation("", ["first.alum"]));
show("occasion null-ish (String(null))", resolveSituation(String(null), ["first.alum"]));
show("boxes from another occasion only", resolveSituation("first_contact", ["thanks.chat", "offers.accept"]));
show("mixed: one valid + two foreign", resolveSituation("first_contact", ["first.alum", "thanks.chat", "offers.accept"]));
show("unknown box ids", resolveSituation("thanks", ["nope.1", "nope.2"]));
show("two boxes from a mode:one section", resolveSituation("follow_up", ["follow.first", "follow.final"]));
show("three boxes from a mode:one section", resolveSituation("offers", ["offers.accept", "offers.decline", "offers.rejection"]));
show("excludes A,B order", resolveSituation("thanks", ["thanks.chat", "thanks.interview"]));
show("excludes B,A order", resolveSituation("thanks", ["thanks.interview", "thanks.chat"]));
show("duplicate ids", resolveSituation("first_contact", ["first.alum", "first.alum", "first.alum"]));
show("duplicates that would trip mode:one", resolveSituation("follow_up", ["follow.first", "follow.first"]));
show("empty box list", resolveSituation("thanks", []));
show("50 box ids (all boxes, every occasion)", resolveSituation("thanks", Array.from({length:50},(_,i)=>allBoxes[i % allBoxes.length].id)));
show("every box of its own occasion at once", resolveSituation("thanks", OCCASIONS.find(o=>o.id==="thanks")!.sections.flatMap(s=>s.boxes).map(b=>b.id)));
show("whitespace box id", resolveSituation("thanks", [" thanks.chat "]));
show("prototype-pollution-ish box id", resolveSituation("thanks", ["__proto__", "constructor"]));
show("prototype-pollution-ish occasion", resolveSituation("__proto__", ["thanks.chat"]));
show("custom occasion, its one box", resolveSituation("custom", ["custom.describe"]));
show("custom occasion, foreign box", resolveSituation("custom", ["thanks.chat"]));

// order independence
say("");
let orderDiff = 0;
for (const c of valid) {
  const rev = resolveSituation(c.occ, [...c.boxes].reverse());
  if ("error" in rev) { orderDiff++; say(`  ORDER: ${c.boxes.join("+")} valid forwards, error reversed`); continue; }
  const same = rev.lead.id === c.situation.lead.id &&
    rev.also.map(b=>b.id).join(",") === c.situation.also.map(b=>b.id).join(",") &&
    rev.summary === c.situation.summary &&
    JSON.stringify(rev.presets) === JSON.stringify(c.situation.presets);
  if (!same) { orderDiff++; if (orderDiff<8) say(`  ORDER-DEPENDENT: ${c.occ} ${c.boxes.join("+")}: fwd lead=${c.situation.lead.id} rev lead=${rev.lead.id}`); }
}
say(`order-dependent results across all ${valid.length} valid combinations: ${orderDiff}`);

// ------------------------------------------------------- 5. question enumeration
say("");
say("## 5. Question coverage over every valid combination");

const aliasGroupOf = (name: string) => [name, ...aliasesOf(name)].sort().join("|");
const fieldOwners = new Map<string, string[]>(); // field name -> type ids
for (const t of EMAIL_TYPES) for (const f of t.fields ?? []) fieldOwners.set(f.name, [...(fieldOwners.get(f.name) ?? []), t.id]);

type Anom = { kind: string; detail: string };
const anomalies: Anom[] = [];
const push = (kind: string, detail: string) => anomalies.push({ kind, detail });

const askedNames = new Set<string>();
const askedLabels = new Map<string, Set<string>>();
let maxQ = { n: 0, c: "" };
const requiredByCase: { c: string; req: { name: string; label: string; prompt: boolean }[] }[] = [];

for (const c of valid) {
  const key = `${c.occ}[${c.boxes.join("+")}]`;
  const qs = situationQuestions(c.situation, () => undefined);
  if (qs.length > maxQ.n) maxQ = { n: qs.length, c: key };
  for (const q of qs) {
    askedNames.add(q.name);
    if (!askedLabels.has(q.name)) askedLabels.set(q.name, new Set());
    askedLabels.get(q.name)!.add(q.label);
  }
  // duplicate name
  const names = qs.map((q) => q.name);
  const dupName = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupName.length) push("DUPLICATE-NAME", `${key}: ${[...new Set(dupName)].join(",")}`);
  // two questions in one alias group
  const groups = new Map<string, string[]>();
  for (const q of qs) { const g = aliasGroupOf(q.name); if (aliasesOf(q.name).length) groups.set(g, [...(groups.get(g) ?? []), q.name]); }
  for (const [g, ns] of groups) if (ns.length > 1) push("ALIAS-DUP", `${key}: group ${g} asked as ${ns.join(" AND ")}`);
  // two different questions with the same visible label
  const byLabel = new Map<string, string[]>();
  for (const q of qs) byLabel.set(q.label, [...(byLabel.get(q.label) ?? []), q.name]);
  for (const [l, ns] of byLabel) if (ns.length > 1) push("SAME-LABEL", `${key}: "${l}" asked as ${ns.join(" AND ")}`);
  // a question whose name is a preset key (should be impossible)
  for (const q of qs) if (q.name in c.situation.presets) push("PRESET-ASKED", `${key}: ${q.name}`);
  // a question whose ALIAS is a preset key (preset + typed answer can collide)
  for (const q of qs) for (const a of aliasesOf(q.name)) if (a in c.situation.presets) push("PRESET-ALIAS", `${key}: question ${q.name} aliases preset ${a}`);
  // showWhen controller not visible
  for (const q of qs) if (q.showWhen && !qs.some((o) => o.name === q.showWhen!.field)) {
    push("ORPHAN-SHOWWHEN", `${key}: ${q.name} depends on ${q.showWhen.field} which is not asked`);
  }
  // required questions
  const req = qs.filter((q) => q.required).map((q) => ({ name: q.name, label: q.label, prompt: Boolean(q.prompt) }));
  if (req.length) requiredByCase.push({ c: key, req });
  for (const q of req) if (!q.prompt) push("REQUIRED-NO-PROMPT", `${key}: ${q.name} ("${q.label}") is required but has no prompt, so the generic required check skips it`);
  // preset keys with no field to carry them to the model
  const types = situationTypes(c.situation);
  const typeFieldNames = new Set(types.flatMap((t) => (t.fields ?? []).map((f) => f.name)));
  for (const k of Object.keys(c.situation.presets)) if (!typeFieldNames.has(k)) push("PRESET-ORPHAN", `${key}: preset ${k}=${c.situation.presets[k]} matches no field of ${types.map(t=>t.id).join("/")} - never reaches the model`);
  // preset keys owned by a type OTHER than the box that set them
  for (const k of Object.keys(c.situation.presets)) {
    const owners = (fieldOwners.get(k) ?? []).filter((t) => types.some((tt) => tt.id === t));
    if (owners.length > 1) push("PRESET-MULTI-OWNER", `${key}: preset ${k} is a field on ${owners.join(" and ")} - emitted for both`);
  }
  // two boxes presetting the same key
  const boxes = [c.situation.lead, ...c.situation.also];
  const presetKeys = new Map<string, string[]>();
  for (const b of boxes) for (const [k, v] of Object.entries(b.presets ?? {})) presetKeys.set(k, [...(presetKeys.get(k) ?? []), `${b.id}=${v}`]);
  for (const [k, vs] of presetKeys) if (vs.length > 1) push("PRESET-COLLISION", `${key}: ${k} set by ${vs.join(" , ")} -> winner ${c.situation.presets[k]}`);
  // questionText overrides applied for a question that is not asked (dead override)
  for (const b of boxes) for (const n of Object.keys(b.questionText ?? {})) if (!qs.some((q) => q.name === n)) push("DEAD-QUESTIONTEXT", `${key}: ${b.id}.questionText.${n} has nothing to rewrite`);
}
say(`questions distinct names ever asked: ${askedNames.size}`);
say(`largest question set: ${maxQ.n} questions at ${maxQ.c}`);
const labelVariants = [...askedLabels].filter(([, s]) => s.size > 1);
say(`question names with more than one visible label (questionText/merge rewording): ${labelVariants.length}`);
for (const [n, s] of labelVariants) say(`  ${n}: ${[...s].map(l=>JSON.stringify(l)).join(" | ")}`);

say("");
const byKind = new Map<string, Anom[]>();
for (const a of anomalies) byKind.set(a.kind, [...(byKind.get(a.kind) ?? []), a]);
say(`### anomalies by kind (total ${anomalies.length})`);
for (const [k, v] of [...byKind].sort((a,b)=>b[1].length-a[1].length)) {
  say(`${k}: ${v.length}`);
  const uniq = [...new Set(v.map(x=>x.detail.replace(/^[^:]*: /, "")))];
  for (const d of uniq.slice(0, 14)) say(`   - ${d}`);
  if (uniq.length > 14) say(`   ... ${uniq.length - 14} more distinct`);
}

// ---------------------------------- 6. required reachability across select space
say("");
say("## 6. Required questions, and reachability of every field");
const allRequired = EMAIL_TYPES.flatMap((t) => (t.fields ?? []).filter((f) => f.required).map((f) => ({ t: t.id, f })));
say(`type fields marked required: ${allRequired.length}`);
// explore select-answer space per combination to collect every reachable question
const everReachable = new Set<string>();
const everRequired = new Map<string, Set<string>>();
for (const c of valid) {
  const seenSets = new Set<string>();
  const explore = (answers: Record<string, string>, depth: number) => {
    const qs = situationQuestions(c.situation, (n) => answers[n]);
    const sig = qs.map((q) => q.name).join(",");
    if (seenSets.has(sig)) return;
    seenSets.add(sig);
    for (const q of qs) {
      everReachable.add(q.name);
      if (q.required) {
        if (!everRequired.has(q.name)) everRequired.set(q.name, new Set());
        everRequired.get(q.name)!.add(`${c.occ}[${c.boxes.join("+")}]`);
      }
    }
    if (depth === 0) return;
    for (const q of qs) if (q.kind === "select") for (const o of q.options ?? []) explore({ ...answers, [q.name]: o.value }, depth - 1);
  };
  explore({}, 3);
}
say(`distinct question names reachable with some set of select answers: ${everReachable.size}`);
const allFieldNames = new Set(EMAIL_TYPES.flatMap((t) => (t.fields ?? []).map((f) => f.name)));
const neverAsked = [...allFieldNames].filter((n) => !everReachable.has(n));
say(`type fields that NO valid combination can ask (${neverAsked.length}): ${neverAsked.join(", ") || "none"}`);
for (const n of neverAsked) {
  const owners = fieldOwners.get(n)!;
  const f = EMAIL_TYPES.flatMap(t=>t.fields??[]).find(ff=>ff.name===n)!;
  say(`   ${n} on ${owners.join("/")} required=${Boolean(f.required)} prompt=${f.prompt ? "yes":"no"} showWhen=${JSON.stringify(f.showWhen ?? null)}`);
}
const unreachableRequired = allRequired.filter(({ f }) => !everReachable.has(f.name));
say(`REQUIRED type fields unreachable: ${unreachableRequired.length ? unreachableRequired.map(x=>`${x.t}.${x.f.name}`).join(", ") : "none"}`);
say(`required questions actually reachable: ${[...everRequired.keys()].sort().join(", ")}`);

// ---------------------------------------------------- 7. brief handoff mapping
say("");
say("## 7. Brief handoff");
const BRIEF_KEYS = ["financeInterest","wantToLearn","fieldAnswers","threadSubject","specificReason","originalSubject","originalDate","originalAsk","originalBody","originalTypeLabel","followUp1Date","followUp1Body","meetingWhen","conversationDetails","nextStepAsk","introName","introReason","interviewTeam","personalConnection"];
const FORM_READ = ["financeInterest","wantToLearn","specificReason","threadSubject","originalSubject","originalDate","originalAsk","followUp1Date","meetingWhen","conversationDetails","nextStepAsk","introName","introReason","interviewTeam","personalConnection"]; // the `field(...)` reads in runGenerateDraft
const DRAFT_INPUT_FIELDS = ["outsideName","outsideFirm","outsideEmail","outsideRole","outsideGroup","outsideSchool","outsideLinkedin","outsideBackground","financeInterest","wantToLearn","specificReason","originalSubject","originalDate","originalAsk","followUp1Date","meetingWhen","interviewTeam","conversationDetails","personalConnection","nextStepAsk","introName","introReason","extraContext"];
// questions with no prompt: they only reach the model if runGenerateDraft reads them into the brief
const noPrompt = [...askedNames].filter((n) => {
  const q = valid.flatMap(c=>situationQuestions(c.situation,()=>undefined)).find(q=>q.name===n)!;
  return !q.prompt;
});
say(`questions with prompt:"" (only reach the model via the brief): ${noPrompt.sort().join(", ")}`);
const lost = noPrompt.filter((n) => !FORM_READ.includes(n));
say(`>>> prompt-less questions NOT read into the brief (collected, never sent): ${lost.join(", ") || "none"}`);
const unpopulatable = BRIEF_KEYS.filter((k) => k !== "fieldAnswers" && !askedNames.has(k) && !FORM_READ.includes(k) || (FORM_READ.includes(k) && !askedNames.has(k) && !allFieldNames.has(k)));
say(`brief keys with no form question of that name: ${BRIEF_KEYS.filter(k=>!askedNames.has(k)).join(", ")}`);
say(`  (of those, filled by the server itself: originalBody, originalTypeLabel, followUp1Body, fieldAnswers)`);
// type fields whose name collides with a brief key -> sent twice
const collide = [...allFieldNames].filter((n) => FORM_READ.includes(n));
say(`type fields whose name is also read into the brief (sent twice: fieldAnswers + brief line): ${collide.join(", ") || "none"}`);
for (const n of collide) say(`   ${n} on ${fieldOwners.get(n)!.join("/")} prompt=${EMAIL_TYPES.flatMap(t=>t.fields??[]).find(f=>f.name===n)!.prompt ? "yes":"no"}`);
// alias leak into the brief
const briefAliasLeak: string[] = [];
for (const k of ["conversationDetails"]) for (const a of aliasesOf(k)) if (allFieldNames.has(a)) briefAliasLeak.push(`${a} (on ${fieldOwners.get(a)!.join("/")}) -> brief.${k} via answerFor`);
say(`type fields that also land in the brief through answerFor aliasing: ${briefAliasLeak.join("; ") || "none"}`);
// DRAFT_INPUT_FIELDS vs questions
const inputNotAsked = DRAFT_INPUT_FIELDS.filter((n) => !askedNames.has(n) && !n.startsWith("outside") && n !== "extraContext");
say(`DRAFT_INPUT_FIELDS entries that are never a question: ${inputNotAsked.join(", ") || "none"}`);
const askedNotLabelled = [...askedNames].filter((n) => !DRAFT_INPUT_FIELDS.includes(n)).sort();
say(`questions NOT in DRAFT_INPUT_FIELDS (blocked-language gate labels them "One of your answers"): ${askedNotLabelled.length}`);
say(`   ${askedNotLabelled.join(", ")}`);
// type fields double-listed in collectInputs
const dupInInputs = collide.filter((n) => EMAIL_TYPES.flatMap(t=>t.fields??[]).find(f=>f.name===n)!.prompt);
say(`>>> answers that appear TWICE in the saved inputs record (typeFields + DRAFT_INPUT_FIELDS): ${dupInInputs.join(", ") || "none"}`);

// -------------------------------------------------------- 8. answerFor aliasing
say("");
say("## 8. answerFor aliasing");
for (const g of [["metAt","conferenceName","whereMet"],["talkedAbout","whereTalked"],["conversationDetails","conversationDetail","remarkPoint","recruiterExplained"],["lastSpoke","firstTalk"],["adviceFollowed","whatYouDid"],["updateSince","ownNews"]]) {
  say(`  group ${g.join("/")}: ${g.map(n=>`${n}${allFieldNames.has(n)?`(field on ${fieldOwners.get(n)!.join("/")})`:askedNames.has(n)?"(brief q)":"(NO SUCH FIELD)"}`).join(" ")}`);
}
// a case where two names in one group are both answerable in one combination
let aliasBoth = 0;
for (const c of valid) {
  const types = situationTypes(c.situation);
  const names = new Set(types.flatMap(t=>(t.fields??[]).map(f=>f.name)));
  for (const g of [["metAt","conferenceName","whereMet"],["talkedAbout","whereTalked"],["conversationDetails","conversationDetail","remarkPoint","recruiterExplained"],["lastSpoke","firstTalk"],["adviceFollowed","whatYouDid"],["updateSince","ownNews"]]) {
    const present = g.filter(n=>names.has(n));
    if (present.length > 1) {
      aliasBoth++;
      const qs = situationQuestions(c.situation, ()=>undefined).map(q=>q.name);
      const asked = present.filter(n=>qs.includes(n));
      if (aliasBoth <= 12) say(`  ${c.occ}[${c.boxes.join("+")}] has fields ${present.join("+")} on ${types.map(t=>t.id).join("/")} ; asked: ${asked.join(",")} ; answerFor wins: ${g.find(n=>present.includes(n))}`);
    }
  }
}
say(`combinations where two names of one alias group are both real fields: ${aliasBoth}`);

// ---------------------------------------------------- 9. suggestions / autoFill
say("");
say("## 9. suggestions + autoFill");
const hintSpace = [] as { label: string; h: Parameters<typeof suggestions>[0] }[];
for (const sameSchool of [true, false]) for (const knownNotAlum of [true, false, undefined]) for (const role of [null, "Campus Recruiter", "Analyst", "Head of Talent"]) for (const name of [null, "Goldman Recruiting Team", "Jane Doe"]) for (const hasPriorColdEmail of [true, false]) for (const hasFollowUp1 of [true, false]) {
  hintSpace.push({ label: `same=${sameSchool} notAlum=${knownNotAlum} role=${role} name=${name} prior=${hasPriorColdEmail} fu1=${hasFollowUp1}`, h: { sameSchool, knownNotAlum, role, name, hasPriorColdEmail, hasFollowUp1 } });
}
let autoBad = 0, autoEmpty = 0;
for (const { label, h } of hintSpace) for (const outside of [true, false]) for (const occasionId of [undefined, ...OCCASIONS.map(o=>o.id)]) {
  const f = autoFill(h, { outside, occasionId });
  if (!f.occasionId) { autoEmpty++; continue; }
  if (f.boxes.length === 0) continue; // legal: nothing known
  const r = resolveSituation(f.occasionId, f.boxes);
  if ("error" in r) { autoBad++; if (autoBad<=10) say(`  AUTOFILL INVALID: ${label} outside=${outside} occ=${occasionId} -> ${f.occasionId} [${f.boxes.join("+")}] : ${r.error}`); }
  // autoFill must not check a box in a hidden section
  if (!outside) { const vis = new Set(visibleSections(occasionById(f.occasionId)!, false).flatMap(s=>s.boxes.map(b=>b.id))); for (const b of f.boxes) if (!vis.has(b)) say(`  AUTOFILL HIDDEN BOX: ${label} occ=${f.occasionId} box=${b}`); }
}
say(`autoFill states tried: ${hintSpace.length * 2 * (OCCASIONS.length + 1)}`);
say(`autoFill results that resolveSituation rejects: ${autoBad}`);
say(`autoFill results with no occasion at all (nothing known, no choice made): ${autoEmpty}`);
say(`suggestions() ids that are not a box or occasion id: ${[...new Set(hintSpace.flatMap(({h})=>[...suggestions(h)]))].filter(id=>!boxById(id)&&!occasionById(id)).join(", ")||"none"}`);

// -------------------------------------------------------- 10. QUESTION_MERGES
say("");
say("## 10. QUESTION_MERGES");
for (const m of QUESTION_MERGES) {
  const cases = valid.filter((c) => m.boxes.every((b) => c.boxes.includes(b)));
  let fired = 0, notFired: string[] = [];
  for (const c of cases) {
    const qs = situationQuestions(c.situation, () => undefined);
    const hasKeep = qs.some((q) => q.name === m.keep), hasDrop = qs.some((q) => q.name === m.drop);
    if (hasKeep && !hasDrop && qs.find(q=>q.name===m.keep)!.label === m.text.label) fired++;
    else notFired.push(`${c.boxes.join("+")} keep=${hasKeep} drop=${hasDrop}`);
  }
  say(`  merge ${m.boxes.join("+")} keep=${m.keep} drop=${m.drop}: ${cases.length} combinations contain both boxes, merged in ${fired}`);
  for (const n of notFired.slice(0, 6)) say(`     NOT MERGED: ${n}`);
  if (notFired.length > 6) say(`     ... ${notFired.length - 6} more`);
  say(`     keep "${m.keep}" is a field on: ${(fieldOwners.get(m.keep) ?? ["<none>"]).join("/")} ; drop "${m.drop}" on: ${(fieldOwners.get(m.drop) ?? ["<none>"]).join("/")}`);
}

// ---------------------------------------------- 11. required-error label match
say("");
say("## 11. Required-field errors");
const reqNames = new Map<string, Set<string>>();
for (const r of requiredByCase) for (const q of r.req) {
  if (!reqNames.has(q.name)) reqNames.set(q.name, new Set());
  reqNames.get(q.name)!.add(`${q.label}|prompt=${q.prompt}`);
}
say(`combinations with at least one required question: ${requiredByCase.length}/${valid.length}`);
for (const [n, s] of [...reqNames].sort()) say(`  ${n}: ${[...s].join("  ||  ")}`);
// which combinations have a required question that the server enforces with the generic message
const enforced = requiredByCase.filter(r=>r.req.some(q=>q.prompt));
say(`combinations where the generic 'Add "<label>"' error can fire: ${enforced.length}`);
say(`combinations whose only required question has no prompt (generic error cannot fire): ${requiredByCase.length - enforced.length}`);

