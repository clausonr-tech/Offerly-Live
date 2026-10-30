// CORPUS-PLAN probe 2: dump bodies with provenance (which file holds them) and
// sentence indices, so the edit plan can quote exact current text.
//
//   npx tsx scripts/audit-probe/corpus/dump.ts cold_email cold_referral
//   npx tsx scripts/audit-probe/corpus/dump.ts --provenance
//   npx tsx scripts/audit-probe/corpus/dump.ts --v5 1 7
//
// READ-ONLY. No model call, no database.

import { readFileSync } from "node:fs";
import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";
import v3 from "../../../src/lib/email-examples-v3.json";
import v4 from "../../../src/lib/email-examples-v4.json";
import v5 from "../../../src/lib/email-examples-v5.json";

type Ex = { note?: string; subject: string; body: string; section?: number };
const V3 = v3 as Record<string, Ex[]>;
const V4 = v4 as Record<string, Ex[]>;
const V5 = v5 as { examples: (Ex & { boxes: string[] })[] };
const tsSrc = readFileSync(new URL("../../../src/lib/email-examples.ts", import.meta.url), "utf8");

/** Which file a type's nth example (1-based, in EMAIL_EXAMPLES order) came from. */
function provenance(typeId: string, n: number): string {
  const ii = countII(typeId);
  const iii = V3[typeId]?.length ?? 0;
  if (n <= ii) return `email-examples.ts (Volume II) #${n}`;
  if (n <= ii + iii) return `email-examples-v3.json ["${typeId}"][${n - ii - 1}]`;
  return `email-examples-v4.json ["${typeId}"][${n - ii - iii - 1}]`;
}
function countII(typeId: string): number {
  const total = (EMAIL_EXAMPLES as Record<string, Ex[]>)[typeId]?.length ?? 0;
  return total - (V3[typeId]?.length ?? 0) - (V4[typeId]?.length ?? 0);
}

const sentencesOf = (t: string) =>
  t.replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"])/).map((s) => s.trim()).filter(Boolean);
function parts(body: string) {
  const lines = body.split("\n");
  const so = lines.map((l) => l.trim()).lastIndexOf("Best,");
  const a = (so >= 0 ? lines.slice(0, so) : lines).join("\n").trim();
  return { greeting: a.split("\n")[0] ?? "", text: a.split("\n").slice(1).join("\n").trim() };
}

const args = process.argv.slice(2);

if (args.includes("--provenance")) {
  for (const typeId of Object.keys(EMAIL_EXAMPLES as Record<string, Ex[]>)) {
    const total = (EMAIL_EXAMPLES as Record<string, Ex[]>)[typeId].length;
    console.log(
      `${typeId.padEnd(28)} total ${String(total).padStart(2)}  = II ${countII(typeId)} + v3 ${V3[typeId]?.length ?? 0} + v4 ${V4[typeId]?.length ?? 0}`,
    );
  }
} else if (args[0] === "--v5") {
  for (const n of args.slice(1).map(Number)) {
    const e = V5.examples[n - 1];
    console.log(`\n######## v5#${n}  section ${e.section}  boxes ${e.boxes.join("+")}`);
    console.log(`note: ${e.note ?? "-"}`);
    console.log(`subject: ${e.subject}`);
    sentencesOf(parts(e.body).text).forEach((s, i) => console.log(`  [${i}] ${s}`));
  }
} else {
  for (const typeId of args) {
    const examples = (EMAIL_EXAMPLES as Record<string, Ex[]>)[typeId] ?? [];
    examples.forEach((e, i) => {
      console.log(`\n######## ${typeId}#${i + 1}  ${provenance(typeId, i + 1)}`);
      console.log(`note: ${e.note ?? "-"}`);
      console.log(`subject: ${e.subject}`);
      const { greeting, text } = parts(e.body);
      console.log(`greeting: ${greeting}`);
      sentencesOf(text).forEach((s, j) => console.log(`  [${j}] ${s}`));
    });
    void tsSrc;
  }
}
