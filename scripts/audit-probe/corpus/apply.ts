// Applies CORPUS-EDIT-PLAN.md's edit table to the gold example corpus.
//
// The hard part is not the replacement, it is knowing WHICH body a row means.
//
//   * `EDITS[].file` is NOT trusted. EMAIL_EXAMPLES merges three sources and
//     many rows are attributed to the wrong one.
//   * `EDITS[].key` is `typeId#n`, 1-based over the MERGED list, which is
//     Volume II (template literals in email-examples.ts), then Volume III
//     (-v3.json), then Volume IV (-v4.json). So `cold_referral#5` is NOT
//     v3 index 4 - it is v3 index 0, because Volume II supplied the first four.
//     Indexing a per-file array by n-1 silently edits the wrong example.
//
// So this script rebuilds the merge itself: it parses Volume II's body literals
// out of the .ts with their file offsets, reads the two JSON volumes, lays them
// out in merge order, and then ASSERTS that every reconstructed slot is
// byte-identical to the corresponding EMAIL_EXAMPLES body. Nothing is written
// unless all 192 slots match - that assertion is what makes `key` -> file
// location trustworthy rather than inferred.
//
// Uniqueness is then checked inside the resolved body only (file-wide would be
// wrong: "I hope you are doing well!" sits in many bodies), and the .ts is
// edited by byte span so no other example's text can be touched.
//
// JSON is parsed and re-serialised rather than text-patched; both files
// round-trip byte-identical through JSON.stringify(_, null, 2) + "\n", so the
// diff shows only the bodies that actually changed.
//
// Dry run by default; --write changes files.
//
//   npx tsx scripts/audit-probe/corpus/apply.ts
//   npx tsx scripts/audit-probe/corpus/apply.ts --write
import { readFileSync, writeFileSync } from "node:fs";
import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";
import { EDITS as PLAN_EDITS } from "./edits";
import { VARIETY_EDITS } from "./edits-variety";
import { parseTsBodies, signaturesOf, expandSignatures, type TsBody, type JsonRow, type JsonVolume } from "./corpus-map";

const WRITE = process.argv.includes("--write");
// Which table to apply. The plan's 138 are already committed (36aecc6), so
// re-running them finds nothing; --table=variety applies CORPUS-VARIETY's
// second table on top of them.
const TABLE = process.argv.includes("--table=variety") ? "variety" : "plan";
const EDITS: { key: string; find: string; replace: string; shape: string }[] =
  TABLE === "variety" ? VARIETY_EDITS : PLAN_EDITS;
const ROOT = "src/lib/";
const TS = ROOT + "email-examples.ts";
const V3 = ROOT + "email-examples-v3.json";
const V4 = ROOT + "email-examples-v4.json";

const v3 = JSON.parse(readFileSync(V3, "utf8")) as JsonVolume;
const v4 = JSON.parse(readFileSync(V4, "utf8")) as JsonVolume;
let tsText = readFileSync(TS, "utf8");

// ---- lay the three volumes out in merge order ------------------------------
// corpus-map.ts owns the "which file holds typeId#n" arithmetic; apply-check.ts
// --post uses the same module against git HEAD.
const sigs = signaturesOf(tsText);
const tsBodies = parseTsBodies(tsText);

type Slot =
  | { kind: "ts"; key: string; body: string; slot: TsBody }
  | { kind: "json"; key: string; body: string; row: JsonRow; file: string };

const slots = new Map<string, Slot>();
for (const [typeId, examples] of Object.entries(EMAIL_EXAMPLES as Record<string, { body: string }[]>)) {
  const ii = tsBodies.filter((s) => s.typeId === typeId);
  const iii = v3[typeId] ?? [];
  const iv = v4[typeId] ?? [];
  if (ii.length + iii.length + iv.length !== examples.length) {
    throw new Error(`${typeId}: merge arithmetic off (${ii.length}+${iii.length}+${iv.length} vs ${examples.length})`);
  }
  let n = 0;
  for (const s of ii) { const key = `${typeId}#${++n}`; slots.set(key, { kind: "ts", key, body: expandSignatures(s.raw, sigs), slot: s }); }
  for (const row of iii) { const key = `${typeId}#${++n}`; slots.set(key, { kind: "json", key, body: row.body, row, file: V3 }); }
  for (const row of iv) { const key = `${typeId}#${++n}`; slots.set(key, { kind: "json", key, body: row.body, row, file: V4 }); }
}

// ---- the assertion that makes the mapping trustworthy ----------------------
let mismatched = 0;
for (const [typeId, examples] of Object.entries(EMAIL_EXAMPLES as Record<string, { body: string }[]>)) {
  examples.forEach((e, i) => {
    const key = `${typeId}#${i + 1}`;
    const s = slots.get(key);
    if (!s) { console.log(`MISMATCH ${key}: no slot`); mismatched++; return; }
    if (s.body !== e.body) { console.log(`MISMATCH ${key}: slot text != EMAIL_EXAMPLES text (${s.kind})`); mismatched++; }
  });
}
console.log(
  mismatched
    ? `${mismatched} slot mismatches - refusing to write`
    : `slot map verified: ${slots.size}/${slots.size} bodies byte-identical to EMAIL_EXAMPLES`,
);
if (mismatched) process.exit(1);

// ---- apply -----------------------------------------------------------------
// Edits accumulate per slot. For the .ts the replacement is recorded against
// the slot's raw text and spliced back by byte span at the end, so one body's
// edit can never reach another body.
const tsEdited = new Map<TsBody, string>();
let applied = 0;
const skipped: string[] = [];

for (const [n, e] of EDITS.entries()) {
  const s = slots.get(e.key);
  if (!s) { skipped.push(`#${n + 1} ${e.key}: no such body`); continue; }
  if (s.kind === "ts") {
    const cur = tsEdited.get(s.slot) ?? s.slot.raw;
    const hits = cur.split(e.find).length - 1;
    if (hits !== 1) { skipped.push(`#${n + 1} ${e.key} [${e.shape}]: find occurs ${hits}x in the body`); continue; }
    tsEdited.set(s.slot, cur.replace(e.find, e.replace));
  } else {
    const hits = s.row.body.split(e.find).length - 1;
    if (hits !== 1) { skipped.push(`#${n + 1} ${e.key} [${e.shape}]: find occurs ${hits}x in the body`); continue; }
    s.row.body = s.row.body.replace(e.find, e.replace);
  }
  applied++;
}

for (const s of skipped) console.log(`SKIPPED  ${s}`);

if (WRITE) {
  if (skipped.length) { console.log(`\n${skipped.length} skipped - refusing to write a partial application`); process.exit(1); }
  // Splice the .ts spans back from the end so earlier offsets stay valid.
  const ordered = [...tsEdited].sort((a, b) => b[0].start - a[0].start);
  for (const [slot, raw] of ordered) tsText = tsText.slice(0, slot.start) + raw + tsText.slice(slot.end);
  writeFileSync(TS, tsText);
  writeFileSync(V3, JSON.stringify(v3, null, 2) + "\n");
  writeFileSync(V4, JSON.stringify(v4, null, 2) + "\n");
}

console.log(`\n${applied}/${EDITS.length} applied from the ${TABLE} table${WRITE ? " and WRITTEN" : " (dry run)"} · ${skipped.length} skipped`);
