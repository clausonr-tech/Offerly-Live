// CORPUS-PLAN probe 5: render the edit table as the markdown that goes into
// docs/concepts/CORPUS-EDIT-PLAN.md, so the document's table is generated from
// the verified data file rather than retyped. READ-ONLY.
import { EDITS } from "./edits";
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, "<br>").replace(/`/g, "'");
const FILE: Record<string, string> = {
  "email-examples.ts": "`.ts` II",
  "email-examples-v3.json": "`v3`",
  "email-examples-v4.json": "`v4`",
};
let last = "";
console.log("| # | body | file | current text (exact) | replacement (exact) | fixes | variety slot |");
console.log("|---:|---|---|---|---|---|---|");
EDITS.forEach((e, i) => {
  const k = e.key.split("#")[0];
  if (k !== last) { last = k; }
  console.log(
    `| ${i + 1} | \`${e.key}\` | ${FILE[e.file]} | ${esc(e.find)} | ${e.replace === "" ? "*(delete)*" : esc(e.replace)} | ${e.fixes.join(", ")} | ${esc(e.shape)} |`,
  );
});
