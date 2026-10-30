// PROBE 3 - how wide is the substring hole in the new-capitalised-word rule?
//   `known.includes(word.toLowerCase())` passes any capitalised word that is a
//   substring of the original draft + JSON.stringify(facts) + school renderings.
//   npx tsx scripts/audit-probe/logic1/probe3-substring.ts
import { guardRevision } from "../../../src/lib/draft-review";
import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";
import type { DraftPromptInput } from "../../../src/lib/draft-prompt";
import { INPUT, SIGNATURE } from "./fixture";

// Plausible invented proper nouns of the kinds the reviewer actually fabricates:
// firms, people, places, months/weekdays, schools and clubs.
const FIRMS = ["Goldman", "Sachs", "Moelis", "Centerview", "Evercore", "Lazard", "Jefferies", "Guggenheim", "Perella", "Weinberg",
  "Houlihan", "Lokey", "Blackstone", "Carlyle", "Apollo", "Ares", "Oaktree", "Angelo", "Gordon", "Silverpeak", "Ridgemont",
  "Marchbank", "Northgate", "Stonebridge", "Kingsway", "Harborview", "Clearwater", "Brightline", "Pinecrest", "Oakmont"];
const PEOPLE = ["Nadia", "Marcus", "Priya", "Devon", "Imani", "Tomas", "Lena", "Omar", "Sofia", "Elias", "Mira", "Dante",
  "Rosa", "Ines", "Lee", "Chen", "Patel", "Okafor", "Nguyen", "Alvarez", "Kowalski", "Haddad", "Mbeki", "Rourke",
  "Ana", "Mia", "Ali", "Ian", "Eva", "Noa", "Leo", "Zara"];
const PLACES = ["Atlanta", "Austin", "Boise", "Denver", "Hartford", "Phoenix", "Tulsa", "Omaha", "Reno", "Tampa",
  "Midtown", "Brooklyn", "Greenwich", "Stamford", "Charlotte", "Houston"];
const TIMES = ["January", "February", "March", "April", "June", "July", "August", "October", "November", "December",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "Thanksgiving", "Easter"];
const SCHOOLS = ["Wharton", "Haas", "Ross", "Booth", "Kellogg", "Sloan", "Tuck", "Fuqua", "Darden", "Kenan",
  "Georgetown", "Villanova", "Emory", "Tulane", "Baylor", "Rutgers"];
const CLUBS = ["Smartwood", "Quadrangle", "Beacon", "Lantern", "Keystone", "Sapphire", "Meridian", "Vanguard",
  "Horizon", "Cornerstone", "Summit", "Catalyst", "Pinnacle", "Trident", "Orchard", "Willow"];
const ALL = [
  ...FIRMS.map((w) => ["firm", w] as const),
  ...PEOPLE.map((w) => ["person", w] as const),
  ...PLACES.map((w) => ["place", w] as const),
  ...TIMES.map((w) => ["month/day", w] as const),
  ...SCHOOLS.map((w) => ["school", w] as const),
  ...CLUBS.map((w) => ["club", w] as const),
];

/** The `known` blob exactly as guardRevision builds it (minus school renderings, which add no short tokens here). */
function knownBlob(facts: DraftPromptInput, body: string): string {
  const { now: _n, ...typed } = facts;
  return `s\n${bodyAbove(body)}\n${JSON.stringify(typed)}`.toLowerCase();
}
const bodyAbove = (b: string) => {
  const lines = b.split("\n");
  const i = lines.map((l) => l.trim()).lastIndexOf("Best,");
  return (i >= 0 ? lines.slice(0, i) : lines).join("\n").trimEnd();
};
/** True when the word is NOT a whole word anywhere in `known` - i.e. only the substring test can admit it. */
const onlySubstring = (word: string, facts: DraftPromptInput, body: string) =>
  !new RegExp(`\\b${word.toLowerCase()}\\b`).test(knownBlob(facts, body));

/** Does the guard let `word` into the body as a brand-new capitalised word? */
function passes(word: string, facts: DraftPromptInput, body: string): boolean {
  // Inserted mid-sentence so the rule actually applies, and with no digits.
  const revised = body.replace("\n\nBest,", `\n\nI also spoke with ${word} about this.\n\nBest,`);
  if (revised === body) throw new Error("no insertion point");
  const r = guardRevision({ subject: "s", body }, { subject: "s", body: revised }, facts, []);
  // Only a rejection that NAMES the word counts as the name rule blocking it.
  return r.ok || !new RegExp(`added "${word}"`).test((r as { reason: string }).reason);
}

function report(label: string, facts: DraftPromptInput, body: string, knownLen: number) {
  const byKind = new Map<string, { n: number; pass: string[] }>();
  for (const [kind, word] of ALL) {
    if (!onlySubstring(word, facts, body)) continue; // already a legitimate whole word in known
    const e = byKind.get(kind) ?? { n: 0, pass: [] };
    e.n++;
    if (passes(word, facts, body)) e.pass.push(word);
    byKind.set(kind, e);
  }
  const tot = [...byKind.values()].reduce((a, b) => a + b.n, 0);
  const got = [...byKind.values()].reduce((a, b) => a + b.pass.length, 0);
  console.log(`\n${label}  (|known| = ${knownLen} chars)`);
  console.log(`  OVERALL: ${got}/${tot} invented proper nouns ADMITTED (${((got / tot) * 100).toFixed(1)}%)`);
  for (const [kind, e] of byKind) {
    console.log(`   ${kind.padEnd(10)} ${String(e.pass.length).padStart(2)}/${e.n}  ${e.pass.join(" ") || "-"}`);
  }
}

const knownLen = (facts: DraftPromptInput, body: string) => {
  const { now: _n, ...t } = facts;
  return `s\n${body}\n${JSON.stringify(t)}`.length;
};

// A. the short fixture draft, sparse facts.
const SHORT = `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel. Would you have 15 minutes for a call?

Thank you!

${SIGNATURE}`;
report("A  short draft, sparse facts", INPUT, SHORT, knownLen(INPUT, SHORT));

// B. a realistic full draft with the brief a real student fills in.
const RICH: DraftPromptInput = {
  ...INPUT,
  alumniSchool: "University of Pennsylvania",
  contactSchool: "Dartmouth College",
  purpose: "ask about how restructuring coverage differs from a generalist group",
  extraContext: "I am applying to the sophomore diversity programs this autumn and want to understand credit.",
  brief: {
    ...INPUT.brief,
    financeInterest: "distressed credit and special situations",
    wantToLearn: "how a restructuring group decides which capital structure is worth the time",
    conversationDetails: "her advice about staffing on live deals and how she moved from audit to restructuring",
    personalConnection: "we both grew up outside a small industrial town and both rowed in high school",
  },
};
const LONG = `Hi Rachel,

Jeff Moreno suggested I write to you, and it was great to meet you at the WITG x WUEC panel.

I am a sophomore at the University of Pennsylvania studying finance, and I have spent the last year on valuation and comparable company analysis for a student investment fund. Your advice about staffing on live deals and how you moved from audit to restructuring is what stuck with me, and I have been reading about how distressed situations get sourced.

Would you have 15 minutes for a call in the next few weeks? My resume is attached.

Thank you!

${SIGNATURE}`;
report("B  realistic draft, full brief", RICH, LONG, knownLen(RICH, LONG));

// C. across the real corpus: every example body in email-examples.ts as the original draft.
const bodies = Object.values(EMAIL_EXAMPLES).flat().map((e) => e.body).filter((b) => b.includes("\n\nBest,"));
let admitted = 0;
let trials = 0;
const perWord = new Map<string, number>();
for (const body of bodies) {
  for (const [, word] of ALL) {
    if (!onlySubstring(word, INPUT, body)) continue; // a whole word in known: not the hole
    trials++;
    if (passes(word, INPUT, body)) {
      admitted++;
      perWord.set(word, (perWord.get(word) ?? 0) + 1);
    }
  }
}
console.log(`\nC  the real corpus: ${bodies.length} example bodies x ${ALL.length} invented nouns, counting ONLY trials where the`);
console.log(`   word is not already a whole word in \`known\` - so every pass below is the substring test and nothing else.`);
console.log(`  OVERALL: ${admitted}/${trials} admitted (${((admitted / trials) * 100).toFixed(1)}%)`);
console.log(`  words admitted on >=1 body, by how many bodies admit them:`);
for (const [w, n] of [...perWord.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${w.padEnd(14)} ${n}/${bodies.length} bodies (${((n / bodies.length) * 100).toFixed(0)}%)`);
}

const admittedWords = [...perWord.keys()];
const byLen = new Map<number, number>();
for (const w of admittedWords) byLen.set(w.length, (byLen.get(w.length) ?? 0) + 1);
console.log(`\n  LENGTH of the ${admittedWords.length} words ever admitted by the substring test:`);
for (const len of [...byLen.keys()].sort((a, b) => a - b)) console.log(`    ${len} letters: ${byLen.get(len)}`);
const allByLen = new Map<number, number>();
for (const [, w] of ALL) allByLen.set(w.length, (allByLen.get(w.length) ?? 0) + 1);
console.log(`  for comparison, the ${ALL.length} words tried:`);
for (const len of [...allByLen.keys()].sort((a, b) => a - b)) console.log(`    ${len} letters: ${allByLen.get(len)}`);
console.log(`  longest word ever admitted: ${Math.max(...admittedWords.map((w) => w.length))} letters; longest tried: ${Math.max(...ALL.map(([, w]) => w.length))}`);
