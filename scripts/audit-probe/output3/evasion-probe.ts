// OUTPUT-3 audit probe: what findBlockedLanguage catches and what it does not.
//   npx tsx scripts/audit-probe/output3/evasion-probe.ts
// Read-only: imports lib/content-limits and prints a table. No API, no DB.

import { findBlockedLanguage } from "../../../src/lib/content-limits";

const ZWJ = "‍";
const ZWSP = "​";
const CYR_A = "а"; // Cyrillic a
const CYR_O = "о"; // Cyrillic o
const CYR_E = "е"; // Cyrillic e
const CYR_C = "с"; // Cyrillic c
const CYR_I = "і"; // Ukrainian i

type Row = { cls: string; sample: string; shown: string };
const rows: Row[] = [];
const add = (cls: string, sample: string, shown = JSON.stringify(sample)) => rows.push({ cls, sample, shown });

// Baselines: these must be caught.
add("plain (baseline)", "you are a fucking idiot");
add("plain slur (baseline)", "he is a faggot");
add("documented disguise: !", "what a sh!t show");
add("documented disguise: spaced", "f u c k this");
add("documented disguise: stretched", "fuuuuck this");
add("documented disguise: star", "f*ck this");
add("documented disguise: $", "total a$$hole");
add("documented disguise: dotted", "s.h.i.t happens");

// Candidate evasions.
add("hyphenated", "f-u-c-k this");
add("hyphen pair", "fu-ck this");
add("underscore", "f_u_c_k this");
add("zero-width joiner inside word", `fu${ZWJ}ck this`);
add("zero-width space inside word", `fu${ZWSP}ck this`);
add("cyrillic homoglyph (slur)", `f${CYR_A}ggot`);
add("cyrillic homoglyph (profanity)", `f${CYR_U_PLACEHOLDER()}ck this`);
function CYR_U_PLACEHOLDER() { return "у"; } // Cyrillic u
add("cyrillic o", `c${CYR_O}ck`);
add("cyrillic e+c", `r${CYR_E}tard${CYR_E}d`);
add("cyrillic c", `${CYR_C}unt`);
add("cyrillic i", `b${CYR_I}tch`);
add("leetspeak 1337", "fvck this");
add("leet with digits (documented)", "sh1t");
add("leet 4 for a", "f4ggot");
add("leet 0", "n0b nonsense c0ck");
add("doubled letters (not 3+)", "fuuck this");
add("inserted period mid-word", "fu.ck this");
add("inserted comma mid-word", "fu,ck this");
add("unicode combining mark", "fúck this");
add("fullwidth", "ｆｕｃｋ this");
add("in a URL", "see https://example.com/fuck-this/page");
add("in an email address", "write to fuck@example.com");
add("in a hostname only", "https://shithole.example.com");
add("hashtag/ampersand glue", "f&ck this");
add("word split across newline", "fu\nck this");
add("word split across paragraph", "fuck\nyou");
add("reversed", "kcuf uoy");
add("accented letter", "fück this");
add("suffix not in list", "fucktastic");
add("stem compound (should catch)", "motherfucker");
add("slur stem compound (should catch)", "niggerish");
add("slur not in list: variants", "coons and spades");
add("plural of listed word", "retards");
add("possessive", "that bitch's desk");
add("mid-word with emoji", "fu\u{1F600}ck");

// False-positive guards named in the file's own comment.
const clean = ["Scunthorpe", "assessment", "cocktail", "Pakistan", "fire retardant", "$55 and great!", "Hitchcock", "class of 2025", "Shiitake mushrooms", "analyst"];

console.log("=== evasion matrix (CAUGHT = word list fired) ===");
for (const r of rows) {
  const kind = findBlockedLanguage(r.sample);
  console.log(`${kind ? `CAUGHT(${kind})` : "PASSES    "}  ${r.cls.padEnd(32)} ${r.shown}`);
}
console.log("\n=== must stay clean (false positives) ===");
for (const c of clean) {
  const kind = findBlockedLanguage(c);
  console.log(`${kind ? `FALSE-POSITIVE(${kind})` : "clean         "}  ${JSON.stringify(c)}`);
}
