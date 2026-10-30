// INPUT-1 probe 2: the form and the server call situationQuestions with
// DIFFERENT valueOf functions. The form's ignores situation.presets; the
// server's consults them first. Does that change which questions appear?
//
//   GenerateForm.tsx:269   situationQuestions(situation, (name) => selectValues[name] ?? values[name])
//   draft-request.ts:252   situationQuestions(situation, (name) => situation.presets[name] ?? field(name))
import { OCCASIONS, resolveSituation, situationQuestions, situationTypes, type Situation } from "../../../src/lib/draft-occasions";
import { EMAIL_TYPES } from "../../../src/lib/draft-templates";

const valid: { occ: string; boxes: string[]; s: Situation }[] = [];
for (const o of OCCASIONS) {
  const ids = o.sections.flatMap((s) => s.boxes).map((b) => b.id);
  for (let m = 1; m < 2 ** ids.length; m++) {
    const pick = ids.filter((_, i) => m & (1 << i));
    const r = resolveSituation(o.id, pick);
    if (!("error" in r)) valid.push({ occ: o.id, boxes: pick, s: r });
  }
}
console.log(`valid=${valid.length}`);

console.log("\n## preset-controlled selects and their option order");
for (const t of EMAIL_TYPES) for (const f of t.fields ?? []) if (f.kind === "select" && (t.fields ?? []).some((o) => o.showWhen?.field === f.name)) {
  console.log(`  ${t.id}.${f.name} options=[${(f.options ?? []).map((o, i) => `${i === 0 ? "*" : ""}${o.value}`).join(", ")}]  (first = the form's assumed default)`);
  for (const d of (t.fields ?? []).filter((o) => o.showWhen?.field === f.name)) {
    console.log(`      dependent ${d.name} shows when ${f.name} in [${d.showWhen!.is.join(",")}]  required=${Boolean(d.required)} prompt=${d.prompt ? "yes" : "no"}`);
  }
}

console.log("\n## form view vs server view, per valid combination (empty answers)");
let diffs = 0;
for (const c of valid) {
  const formQ = situationQuestions(c.s, (n) => undefined).map((q) => q.name);              // form: presets ignored
  const serverQ = situationQuestions(c.s, (n) => c.s.presets[n] ?? undefined).map((q) => q.name); // server
  const onlyForm = formQ.filter((n) => !serverQ.includes(n));
  const onlyServer = serverQ.filter((n) => !formQ.includes(n));
  if (onlyForm.length || onlyServer.length) {
    diffs++;
    const reqServer = situationQuestions(c.s, (n) => c.s.presets[n] ?? undefined).filter((q) => onlyServer.includes(q.name) && q.required);
    console.log(`  ${c.occ}[${c.boxes.join("+")}] presets=${JSON.stringify(c.s.presets)}`);
    console.log(`      form-only: ${onlyForm.join(",") || "-"}    server-only: ${onlyServer.join(",") || "-"}`);
    if (reqServer.length) console.log(`      !! server REQUIRES a question the form never showed: ${reqServer.map((q) => `${q.name} ("${q.label}")`).join(", ")}  -> error: Add "${reqServer[0].label}" to draft this email.`);
  }
}
console.log(`combinations where the form's and the server's question sets differ: ${diffs}/${valid.length}`);

console.log("\n## every reachable question name, form-style vs with select answers explored");
const reach = (valueOf: (n: string) => string | undefined) => {
  const names = new Set<string>();
  for (const c of valid) {
    const seen = new Set<string>();
    const go = (ans: Record<string, string>, d: number) => {
      const qs = situationQuestions(c.s, (n) => ans[n] ?? valueOf(n));
      const sig = qs.map((q) => q.name).join(",");
      if (seen.has(sig)) return;
      seen.add(sig);
      qs.forEach((q) => names.add(q.name));
      if (!d) return;
      for (const q of qs) if (q.kind === "select") for (const o of q.options ?? []) go({ ...ans, [q.name]: o.value }, d - 1);
    };
    go({}, 3);
  }
  return names;
};
const base = new Set<string>(), explored = reach(() => undefined);
for (const c of valid) situationQuestions(c.s, () => undefined).forEach((q) => base.add(q.name));
console.log(`names asked with no answers at all: ${base.size}`);
console.log(`names reachable once selects are answered: ${explored.size}`);
console.log(`only reachable after a select is changed: ${[...explored].filter((n) => !base.has(n)).sort().join(", ")}`);

console.log("\n## full question list for the worst combinations");
for (const key of ["stay|stay.update+stay.congrats+stay.referrer", "stay|stay.update+stay.congrats", "stay|stay.update+stay.referrer", "thanks|thanks.chat+thanks.helped", "thanks|thanks.helped+thanks.event", "first_contact|first.alum+first.recruiter+first.referred+first.met", "first_contact|first.not_alum+first.recruiter", "first_contact|first.not_alum+first.recruiter+first.referred"]) {
  const [occ, bx] = key.split("|");
  const c = valid.find((v) => v.occ === occ && v.boxes.join("+") === bx);
  if (!c) { console.log(`  (no such combination: ${key})`); continue; }
  const qs = situationQuestions(c.s, (n) => c.s.presets[n] ?? undefined);
  console.log(`  ${key}  lead=${c.s.lead.id} types=${situationTypes(c.s).map((t) => t.id).join("/")}  ${qs.length} questions`);
  for (const q of qs) console.log(`      ${q.required ? "*" : " "} ${q.name.padEnd(20)} [${q.section}] ${JSON.stringify(q.label)}${q.prompt ? "" : "  (no prompt - brief only)"}`);
}
