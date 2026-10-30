import { resolveSituation, situationQuestions } from "@/lib/draft-occasions";
for (const ids of [["first.conference"], ["first.conference", "first.alum"], ["first.alum"]]) {
  const sit = resolveSituation("first_contact", ids);
  if ("error" in sit) { console.log(ids.join("+"), "ERROR", sit.error); continue; }
  const qs = situationQuestions(sit, () => undefined);
  console.log(`\n[${ids.join(", ")}] lead=${sit.lead.id} (${sit.lead.typeId})`);
  for (const q of qs) console.log(`   ${q.name.padEnd(20)} prompt=${q.prompt ? "yes" : "EMPTY"}  "${q.label}"`);
}
