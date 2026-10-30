// Scratch (OUTPUT-1 audit): print the student's typed answers for given scenario ids.
import { sims } from "../../draft-occasions-sim";

const want = new Set(process.argv.slice(2));
for (const s of sims()) {
  if (want.size && !want.has(s.id)) continue;
  console.log(`\n==== ${s.id} [${s.profile}] ${s.ids.join("+")} · ${s.situation.summary}`);
  console.log(`recipient: ${s.input.contactName} / ${s.input.contactRole} / ${s.input.contactFirm} / school=${s.input.contactSchool ?? "-"}`);
  console.log(`type: ${s.input.type} also=${(s.input.alsoTypes ?? []).join(",") || "-"} gmailSig=${s.input.gmailSignature}`);
  const b = s.input.brief ?? {};
  for (const [k, v] of Object.entries(b)) {
    if (k === "fieldAnswers" || v === undefined) continue;
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  }
  for (const fa of b.fieldAnswers ?? []) console.log(`  Q: ${fa.prompt}\n     A: ${fa.value}`);
}
