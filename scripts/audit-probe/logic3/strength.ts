// LOGIC-3 probe: STRENGTH coverage and order-dependence of the lead.
import { OCCASIONS, resolveSituation } from "@/lib/draft-occasions";
import { allCombos } from "./enumerate";

const src = require("fs").readFileSync("src/lib/draft-occasions.ts", "utf8") as string;
const block = src.slice(src.indexOf("const STRENGTH = ["), src.indexOf("];", src.indexOf("const STRENGTH = [")));
const ranked = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const all = OCCASIONS.flatMap((o) => o.sections.flatMap((s) => s.boxes.map((b) => b.id)));
console.log(`boxes total ${all.length}; in STRENGTH ${ranked.length}`);
console.log("boxes NOT in STRENGTH:", all.filter((id) => !ranked.includes(id)).join(", "));
console.log("STRENGTH ids that are not boxes:", ranked.filter((id) => !all.includes(id)).join(", ") || "(none)");

// Does the lead depend on the order the client sent the ids?
let flips = 0;
const examples: string[] = [];
for (const c of allCombos()) {
  if (c.ids.length < 2) continue;
  const fwd = resolveSituation(c.occasion, c.ids);
  const rev = resolveSituation(c.occasion, [...c.ids].reverse());
  if ("error" in fwd || "error" in rev) continue;
  if (fwd.lead.id !== rev.lead.id) {
    flips++;
    if (examples.length < 12) examples.push(`${c.occasion} [${c.ids.join(",")}] -> lead ${fwd.lead.id} | reversed -> ${rev.lead.id}`);
  }
}
console.log(`\nmulti-box combos whose LEAD changes when the id order is reversed: ${flips}`);
examples.forEach((e) => console.log("  " + e));

// Also: does `also` ordering flip (affects ALSO TRUE order / presets precedence)?
let alsoFlips = 0;
for (const c of allCombos()) {
  if (c.ids.length < 3) continue;
  const fwd = resolveSituation(c.occasion, c.ids);
  const rev = resolveSituation(c.occasion, [...c.ids].reverse());
  if ("error" in fwd || "error" in rev) continue;
  if (fwd.also.map((b) => b.id).join(",") !== rev.also.map((b) => b.id).join(",")) alsoFlips++;
}
console.log(`combos (3+ boxes) whose ALSO order changes on reversal: ${alsoFlips}`);
