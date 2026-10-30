// LOGIC-2 audit probe: shared gold-corpus loader. Read-only on src/.
import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";
import volumeV from "../../../src/lib/email-examples-v5.json";

export type Gold = { id: string; type: string; corpus: "per-type" | "v5"; body: string };

export function gold(): Gold[] {
  const out: Gold[] = [];
  for (const [typeId, examples] of Object.entries(EMAIL_EXAMPLES as Record<string, { body: string }[]>)) {
    examples.forEach((e, i) => out.push({ id: `${typeId}#${i + 1}`, type: typeId, corpus: "per-type", body: e.body }));
  }
  const V = volumeV as { examples: { boxes: string[]; body: string }[] };
  V.examples.forEach((e, i) => out.push({ id: `v5#${i + 1}`, type: "custom", corpus: "v5", body: e.body }));
  return out;
}

/** The same slice draftChecks lints: body minus greeting line and minus everything from "Best,". */
export function mainText(body: string): string {
  const lines = body.split("\n");
  const signOff = lines.map((l) => l.trim()).lastIndexOf("Best,");
  const main = (signOff >= 0 ? lines.slice(0, signOff) : lines).join("\n").trim();
  return main.split("\n").slice(1).join("\n").trim();
}
