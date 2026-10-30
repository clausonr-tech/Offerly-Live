import { buildDraftPrompt } from "@/lib/draft-prompt";
import { sims } from "../../draft-occasions-sim";
const want = process.argv.slice(2);
for (const s of sims()) {
  if (!want.includes(s.id)) continue;
  const { userText } = buildDraftPrompt(s.input);
  const i = userText.indexOf("\nTHIS EMAIL\n");
  const rest = userText.slice(i + 1);
  const end = rest.search(/\n\n[A-Z][A-Z ’'()]{4,}\n/);
  console.log(`\n########## sim ${s.id}  [${s.ids.join(", ")}]  lead=${s.input.type} also=${(s.input.alsoTypes ?? []).join(",")}`);
  console.log(end < 0 ? rest : rest.slice(0, end));
}
