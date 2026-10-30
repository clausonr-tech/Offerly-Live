// Maps an EMAIL_EXAMPLES key (`typeId#n`, 1-based over the MERGED list) to the
// place that body physically lives, from raw file text rather than from the
// imported module - so it can be run against the working tree, against
// `git show HEAD:...`, or against any other revision.
//
// Why this exists: EMAIL_EXAMPLES concatenates Volume II (template literals in
// email-examples.ts), then Volume III (-v3.json), then Volume IV (-v4.json).
// `cold_referral#5` is therefore v3 index 0, not v3 index 4, and the `file`
// column of the edit table is wrong for many rows. Indexing a per-file array by
// n-1 silently edits a different example than the one that was reviewed.
//
// Shared by apply.ts (which needs the byte spans to write) and
// apply-check.ts --post (which needs only the text).

export type TsBody = { typeId: string; start: number; end: number; raw: string };
export type JsonRow = { subject: string; body: string; section?: number; note?: string };
export type JsonVolume = Record<string, JsonRow[]>;

/** The `${X_SIGNATURE}` constants, so a Volume II literal can be expanded. */
export function signaturesOf(tsText: string): Map<string, string> {
  const out = new Map<string, string>();
  // The array literal contains a "]" inside "[phone number]", so match lazily
  // up to the ".join(" rather than to the first "]".
  for (const m of tsText.matchAll(/const (\w+_SIGNATURE) = (\[.*?\])\.join\("\\n"\);/g)) {
    out.set(m[1], (JSON.parse(m[2]) as string[]).join("\n"));
  }
  return out;
}

/** Volume II's `body: `...`` literals, in file order, with their byte spans. */
export function parseTsBodies(tsText: string): TsBody[] {
  const keys: { id: string; at: number }[] = [];
  for (const m of tsText.matchAll(/^ {2}([a-z_]+): \[$/gm)) keys.push({ id: m[1], at: m.index! });
  const out: TsBody[] = [];
  for (const m of tsText.matchAll(/^ {6}body: `/gm)) {
    const start = m.index! + m[0].length;
    const end = tsText.indexOf("`", start); // no escaped backticks in this file
    if (end < 0) throw new Error("unterminated body literal at " + start);
    const owner = [...keys].reverse().find((k) => k.at < m.index!);
    if (!owner) throw new Error("body literal with no type key above it");
    out.push({ typeId: owner.id, start, end, raw: tsText.slice(start, end) });
  }
  return out;
}

export function expandSignatures(raw: string, signatures: Map<string, string>): string {
  return raw.replace(/\$\{(\w+)\}/g, (_, n: string) => {
    const v = signatures.get(n);
    if (v === undefined) throw new Error("unknown interpolation ${" + n + "}");
    return v;
  });
}

/**
 * Every `typeId#n` -> body text, in the same merge order EMAIL_EXAMPLES uses.
 * `typeIds` fixes the set of types to walk (pass Object.keys(EMAIL_EXAMPLES)).
 */
export function bodyMap(tsText: string, v3: JsonVolume, v4: JsonVolume, typeIds: string[]): Map<string, string> {
  const sigs = signaturesOf(tsText);
  const ts = parseTsBodies(tsText);
  const out = new Map<string, string>();
  for (const typeId of typeIds) {
    const ii = ts.filter((s) => s.typeId === typeId);
    const iii = v3[typeId] ?? [];
    const iv = v4[typeId] ?? [];
    let n = 0;
    for (const s of ii) out.set(`${typeId}#${++n}`, expandSignatures(s.raw, sigs));
    for (const r of iii) out.set(`${typeId}#${++n}`, r.body);
    for (const r of iv) out.set(`${typeId}#${++n}`, r.body);
  }
  return out;
}
