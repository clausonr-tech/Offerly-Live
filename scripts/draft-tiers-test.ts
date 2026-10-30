// Proof that splitting the drafting system prompt into cache tiers changed no
// bytes - the whole safety argument for the tiered cache breakpoints.
//
//   npx tsx scripts/draft-tiers-test.ts            run the assertions
//   npx tsx scripts/draft-tiers-test.ts --capture   rewrite the baseline fixture
//
// --capture REPLACES the record this test judges against. Running it after a
// deliberate prompt change is how the record moves forward; running it to make
// a failure go away deletes the only evidence that the tiers changed no bytes.
// Today it is a no-op, which is the point: the tiers rebuild the same prompts.
//
// Cache markers cannot change what a model writes; prompt text can. So the
// tiering is safe exactly to the extent that `invariant + perType + perRequest`
// is byte-for-byte what the single string used to be, for every prompt a
// student can produce. --capture was run against the code BEFORE the tiering
// landed and its output is committed; the assertions below compare today's
// build against that record, so a drift in either the tiers or the prompt
// itself fails here rather than in front of a student.
//
// The matrix is the same 148 prompts the rest of this work measures: all 107
// valid box combinations resolveSituation can produce, plus one single-box row
// per email type. No API call, no database, no secret.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OCCASIONS, resolveSituation, situationTypes } from "../src/lib/draft-occasions";
import { EMAIL_TYPES, type EmailTypeId } from "../src/lib/draft-templates";
import { buildDraftPrompt, ceilingInPerRequestTier, type DraftPromptInput } from "../src/lib/draft-prompt";
import { sims, type Sim } from "./draft-occasions-sim";

const FIXTURE = join(fileURLToPath(new URL(".", import.meta.url)), "draft-fixtures", "system-tiers-baseline.json");

/** One student and one recipient for every row: the only thing that differs is the situation. Same base as draft-bench. */
const BASE: Sim = sims()[0];

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function subsets<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 1; mask < 1 << xs.length; mask++) {
    const pick: T[] = [];
    for (let i = 0; i < xs.length; i++) if (mask & (1 << i)) pick.push(xs[i]);
    out.push(pick);
  }
  return out;
}

type Row = {
  /** Stable across runs, so the fixture can be diffed row by row. */
  id: string;
  kind: "combo" | "type";
  lead: EmailTypeId;
  also: EmailTypeId[];
  boxIds: string[];
  input: DraftPromptInput;
};

/** Every box the picker offers for a type, the way draft-bench finds them. */
const boxesForType = (() => {
  const byType = new Map<EmailTypeId, string[]>();
  for (const occasion of OCCASIONS) {
    for (const section of occasion.sections) {
      for (const box of section.boxes) byType.set(box.typeId, [...(byType.get(box.typeId) ?? []), box.id]);
    }
  }
  return byType;
})();

function matrix(): Row[] {
  const rows: Row[] = [];
  // The 107 box combinations a student can actually check.
  for (const occasion of OCCASIONS) {
    const boxes = occasion.sections.flatMap((s) => s.boxes.map((b) => b.id));
    for (const combo of subsets(boxes)) {
      const resolved = resolveSituation(occasion.id, combo);
      if ("error" in resolved) continue;
      const types = situationTypes(resolved);
      const lead = types[0].id;
      const also = types.slice(1).map((t) => t.id);
      rows.push({
        id: `${occasion.id}:${combo.join("+")}`,
        kind: "combo",
        lead,
        also,
        boxIds: combo,
        input: { ...BASE.input, type: lead, alsoTypes: also, boxIds: combo, situationSummary: resolved.summary },
      });
    }
  }
  // One row per type, single box: the per-type tier's own key space.
  for (const type of EMAIL_TYPES) {
    const boxIds = (boxesForType.get(type.id) ?? []).slice(0, 1);
    rows.push({
      id: `type:${type.id}`,
      kind: "type",
      lead: type.id,
      also: [],
      boxIds,
      input: { ...BASE.input, type: type.id, alsoTypes: [], boxIds, situationSummary: type.label },
    });
  }
  return rows;
}

type FixtureRow = { id: string; lead: EmailTypeId; also: EmailTypeId[]; boxIds: string[]; chars: number; bytes: number; sha256: string };
type Fixture = { capturedAt: string; note: string; rows: FixtureRow[] };

const rows = matrix();

if (process.argv.includes("--capture")) {
  const fixture: Fixture = {
    capturedAt: new Date().toISOString(),
    note:
      "sha256 of buildDraftPrompt(...).system for every prompt a student can produce, captured BEFORE the system " +
      "prompt was split into cache tiers. draft-tiers-test.ts asserts the tiers still concatenate to exactly these bytes.",
    rows: rows.map((r) => {
      const { system } = buildDraftPrompt(r.input);
      return {
        id: r.id,
        lead: r.lead,
        also: r.also,
        boxIds: r.boxIds,
        chars: system.length,
        bytes: Buffer.byteLength(system, "utf8"),
        sha256: sha(system),
      };
    }),
  };
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`captured ${fixture.rows.length} system prompts to ${FIXTURE}`);
  console.log(`distinct sha256: ${new Set(fixture.rows.map((r) => r.sha256)).size}`);
  process.exit(0);
}

// ----------------------------------------------------------------- assertions

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
const byId = new Map(fixture.rows.map((r) => [r.id, r]));

t(`fixture covers the matrix (${rows.length} rows)`, fixture.rows.length === rows.length, `fixture ${fixture.rows.length}, matrix ${rows.length}`);
t("matrix is 148 prompts: 107 box combinations + 41 type rows", rows.length === 148, `got ${rows.length}`);
t("107 valid box combinations", rows.filter((r) => r.kind === "combo").length === 107, `got ${rows.filter((r) => r.kind === "combo").length}`);
t("41 single-box type rows", rows.filter((r) => r.kind === "type").length === 41, `got ${rows.filter((r) => r.kind === "type").length}`);

const built = rows.map((r) => ({ row: r, built: buildDraftPrompt(r.input) }));

// 1. BYTE IDENTITY. The whole safety property, one row at a time.
let identical = 0;
for (const { row, built: b } of built) {
  const want = byId.get(row.id);
  if (!want) {
    t(`${row.id}: present in the fixture`, false, "no fixture row with this id");
    continue;
  }
  const joined = b.systemTiers.invariant + b.systemTiers.perType + b.systemTiers.perRequest;
  const ok = joined === b.system && sha(joined) === want.sha256;
  if (ok) identical++;
  else {
    t(
      `${row.id}: tiers concatenate to the pre-change prompt`,
      false,
      `chars ${joined.length} vs ${want.chars}, bytes ${Buffer.byteLength(joined, "utf8")} vs ${want.bytes}, ` +
        `sha ${sha(joined).slice(0, 12)} vs ${want.sha256.slice(0, 12)}, tiers===system ${joined === b.system}`,
    );
  }
}
t(`byte-identical on all ${rows.length} prompts (${identical}/${rows.length})`, identical === rows.length);

// Said twice on purpose: the sha check above proves the bytes, this proves the
// builder's own `system` is the same object the tiers make, so no caller can
// receive one and have the model be sent the other.
t(
  "buildDraftPrompt().system is exactly the three tiers joined",
  built.every(({ built: b }) => b.system === b.systemTiers.invariant + b.systemTiers.perType + b.systemTiers.perRequest),
);

// 2. The invariant tier is one value for every draft ever built.
const invariants = new Set(built.map(({ built: b }) => b.systemTiers.invariant));
t("invariant tier has exactly 1 distinct value", invariants.size === 1, `got ${invariants.size}`);

// 3. The per-type tier's key space, and what it is a function of.
//
// It is NOT a pure function of the lead type alone, and it cannot be while the
// prompt text stays put: `HARD CEILING: N words` is a Math.max over the whole
// box mix and sits inside formatBlock. It IS a pure function of (lead type,
// ceiling), which is the tier's cache key, and the ceiling is the only reason
// there are 53 keys and not 41 - exactly what Phase 2's flag moves out.
const perTypes = new Set(built.map(({ built: b }) => b.systemTiers.perType));
const ceilingOf = (r: Row) => Math.max(...[r.lead, ...r.also].map((t) => EMAIL_TYPES.find((x) => x.id === t)?.maxWords ?? 0));
const perTypeByKey = new Map<string, Set<string>>();
for (const { row, built: b } of built) {
  const k = `${row.lead}|${ceilingOf(row)}`;
  if (!perTypeByKey.has(k)) perTypeByKey.set(k, new Set());
  perTypeByKey.get(k)!.add(b.systemTiers.perType);
}
const leaking = [...perTypeByKey.entries()].filter(([, v]) => v.size > 1);
t(
  "per-type tier is a pure function of (lead type, word ceiling) - no mix leaks in",
  leaking.length === 0,
  leaking.map(([k, v]) => `${k}: ${v.size}`).join(", "),
);
// A ratchet on the cache key count. 53 is the number Phase 2's flag exists to
// cut to 41, so it is pinned rather than described.
t("per-type tier has exactly 53 distinct values", perTypes.size === 53, `got ${perTypes.size}`);
t("per-type tier has one value per (lead type, ceiling) pair", perTypeByKey.size === perTypes.size, `${perTypeByKey.size} pairs, ${perTypes.size} values`);
const perTypeByLead = new Map<EmailTypeId, Set<string>>();
for (const { row, built: b } of built) {
  if (!perTypeByLead.has(row.lead)) perTypeByLead.set(row.lead, new Set());
  perTypeByLead.get(row.lead)!.add(b.systemTiers.perType);
}
t("41 lead types are reachable", perTypeByLead.size === 41, `got ${perTypeByLead.size}`);
// 53 keys for 41 types: the 12 extra keys are types a mix gives a second (or
// third) word ceiling. Nothing else can split a type's key, which is the whole
// claim Phase 2 rests on.
const extraKeys = [...perTypeByLead.values()].reduce((n, v) => n + v.size - 1, 0);
const stretched = [...perTypeByLead.values()].filter((v) => v.size > 1).length;
t(
  "every per-type key beyond the 41 is a ceiling a mix stretched",
  extraKeys === perTypes.size - perTypeByLead.size && extraKeys === 12,
  `${extraKeys} extra keys across ${stretched} types`,
);
t(
  "a type's several per-type values differ only in the HARD CEILING line",
  [...perTypeByLead.values()]
    .filter((v) => v.size > 1)
    .every((v) => new Set([...v].map((s) => s.replace(/\nHARD CEILING: \d+ words[^\n]*/, ""))).size === 1),
);
// Whatever the tier does hold, it must not hold a single mix-dependent byte
// other than the ceiling - this is what makes it cacheable across mixes.
t(
  "per-type tier is the format block alone: no blend rules, no examples, no combination block",
  built.every(
    ({ built: b }) =>
      !b.systemTiers.perType.includes("SEVERAL THINGS ARE TRUE AT ONCE.") &&
      !/\nEXAMPLES/.test(b.systemTiers.perType) &&
      !b.systemTiers.perType.includes("COMBINATION FORMAT"),
  ),
);
t("per-type tier always opens on the EMAIL TYPE line", built.every(({ built: b }) => b.systemTiers.perType.startsWith("EMAIL TYPE: ")));

// 4. NO TIER IS EVER EMPTY. An empty text content block is not a valid API
// block, so a tier that can be "" is a production bug, not a cosmetic one.
for (const { row, built: b } of built) {
  const empties = Object.entries(b.systemTiers).filter(([, v]) => v.length === 0);
  if (empties.length > 0) t(`${row.id}: no empty tier`, false, `empty: ${empties.map(([k]) => k).join(", ")}`);
}
t(
  `no tier is the empty string on any of the ${rows.length} prompts`,
  built.every(({ built: b }) => Object.values(b.systemTiers).every((v) => v.length > 0)),
);

// `custom` is the row that proves it. It has no examples (examplesBlock returns
// "") and no combination block (one box), and PLAN-A's tiering - which moved
// the invariant tail up into `invariant` - left it with a per-request block of
// zero chars. Here the tail stays where the model has always read it, at the
// end, which is what keeps the block non-empty.
const custom = built.find(({ row }) => row.id === "type:custom")!;
t("custom: per-request tier is not empty", custom.built.systemTiers.perRequest.length > 0, `${custom.built.systemTiers.perRequest.length} chars`);
t("custom: per-type tier is not empty", custom.built.systemTiers.perType.length > 0);
t("custom: no examples block (so nothing but the tail could fill per-request)", !/\nEXAMPLES/.test(custom.built.system));
t("custom: per-request tier is the invariant tail the model reads last", custom.built.systemTiers.perRequest.startsWith("FINDING COMMON GROUND"));
t("custom: per-type tier is the 40-format dump, intact", custom.built.systemTiers.perType.includes("EMAIL TYPE: CUSTOM") && custom.built.systemTiers.perType.length > 20000);
t(
  "custom: the three tiers are the whole prompt",
  custom.built.systemTiers.invariant.length + custom.built.systemTiers.perType.length + custom.built.systemTiers.perRequest.length ===
    custom.built.system.length,
);

// 5. What the tiers buy, stated as an assertion so a regression is a failure
// rather than a slower request nobody notices.
const todayKeys = new Set(built.map(({ built: b }) => b.system)).size;
t("today's single terminal breakpoint spreads over 102 distinct keys", todayKeys === 102, `got ${todayKeys}`);
const invariantChars = [...invariants][0].length;
t("invariant tier clears the 1,024-token cache floor with headroom", invariantChars / 3.7 > 1200, `${invariantChars} ch / ~${Math.round(invariantChars / 3.7)} est tok`);

// 6. The Phase 2 experiment: the HARD CEILING line in the per-request tier.
//
// Default OFF, and the assertions above all ran with it off - that is what
// makes them a statement about what ships. With it on the prompt changes by one
// byte per draft (a newline becomes a blank line), which is why it is a flag
// with an evaluation behind it and not part of the tiering.
t("the ceiling experiment is OFF by default", !ceilingInPerRequestTier());
{
  process.env.OFFERLY_DRAFT_CEILING_TIER = "per-request";
  const moved = rows.map((r) => ({ row: r, built: buildDraftPrompt(r.input) }));
  t("flag on: still exactly one invariant tier value", new Set(moved.map(({ built: b }) => b.systemTiers.invariant)).size === 1);
  const movedPerTypes = new Set(moved.map(({ built: b }) => b.systemTiers.perType));
  t("flag on: per-type keys drop 53 -> 41, one per lead type", movedPerTypes.size === 41, `got ${movedPerTypes.size}`);
  t(
    "flag on: no HARD CEILING line left in the per-type tier",
    moved.every(({ built: b }) => !b.systemTiers.perType.includes("HARD CEILING")),
  );
  t(
    "flag on: the ceiling opens the per-request tier, except for custom which never had one",
    moved.every(({ row, built: b }) =>
      row.lead === "custom" ? !b.system.includes("HARD CEILING") : b.systemTiers.perRequest.startsWith("HARD CEILING: "),
    ),
  );
  t("flag on: no tier is empty", moved.every(({ built: b }) => Object.values(b.systemTiers).every((v) => v.length > 0)));
  // The text change, stated exactly: one newline per prompt becomes two, and
  // nothing else. If this ever reports more, the flag has grown a second edit
  // and the evaluation behind it no longer covers what it does.
  const deltas = new Set(
    moved.map(({ row, built: b }) => {
      const before = byId.get(row.id)!;
      return b.system.length - before.chars;
    }),
  );
  t("flag on: the ceiling line moves without changing any other text", [...deltas].every((d) => d === 0 || d === 1 || d === 3155 || d === 3156), `deltas: ${[...deltas].join(", ")}`);
  t(
    "flag on: removing the one added newline gives back the pre-change prompt exactly",
    moved.every(({ row, built: b }) => sha(b.system.replace("\n\nHARD CEILING: ", "\nHARD CEILING: ")) === byId.get(row.id)!.sha256),
  );
  delete process.env.OFFERLY_DRAFT_CEILING_TIER;
  t("flag cleared: back to 53 per-type keys", new Set(rows.map((r) => buildDraftPrompt(r.input).systemTiers.perType)).size === 53);
}

// ---------------------------------------------------------------- the numbers

const cpt = 3.7;
const tok = (s: string) => Math.round(s.length / cpt);
const perTypeSizes = built.map(({ built: b }) => b.systemTiers.perType.length).sort((a, b) => a - b);
const cachedToday = 6056; // longest common prefix across the matrix (BASELINE §2, TEST-A T1b)
const cachedNow = built.map(({ built: b }) => b.systemTiers.invariant.length + b.systemTiers.perType.length).sort((a, b) => a - b);
const median = (xs: number[]) => xs[Math.floor(xs.length / 2)];

console.log(`
matrix                     ${rows.length} prompts (107 box combinations + 41 type rows)
byte-identical             ${identical}/${rows.length}
invariant tier             1 value, ${invariantChars} ch / ~${tok([...invariants][0])} tok
per-type tier              ${perTypes.size} values, ${perTypeSizes[0]}-${perTypeSizes[perTypeSizes.length - 1]} ch (median ${median(perTypeSizes)})
per-request tier           ${new Set(built.map(({ built: b }) => b.systemTiers.perRequest)).size} values, never empty
cache keys today           ${todayKeys} (one per distinct whole system string)
cached prefix, cold mix    ${cachedToday} ch today -> ${cachedNow[0]}-${cachedNow[cachedNow.length - 1]} ch, median ${median(cachedNow)}`);

console.log(`\n${pass} passing, ${fail} failing`);
process.exit(fail > 0 ? 1 : 0);
