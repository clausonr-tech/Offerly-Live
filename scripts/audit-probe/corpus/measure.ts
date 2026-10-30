// CORPUS-PLAN probe 1: re-measure the gold example corpus from scratch.
//
// Reads the 192 per-type gold bodies (EMAIL_EXAMPLES = Volume II in
// email-examples.ts + Volume III + Volume IV JSON) and the 42 Volume V
// combination bodies, and reports per body and in aggregate:
//
//   contraction count · opening type · canned-line hits (verbatim) ·
//   longest run of "I"-opening sentences · em/en dashes · closing sentence
//
// No model call, no database, no API key. READ-ONLY on src/.
//
// The regexes and the body split are COPIED VERBATIM from
// scripts/draft-cli-eval.ts (CONTRACTION, CANNED_LINES, PLEASANTRY,
// sentencesOf, bodyParts) so the figures here are on the same footing as the
// harness's own cannedResume*/pleasantryOpen*/zeroContraction*/threeIStarts*
// aggregates. Copied rather than imported because draft-cli-eval.ts runs a
// main() on import and would spawn model calls.
//
//   npx tsx scripts/audit-probe/corpus/measure.ts            # the report
//   npx tsx scripts/audit-probe/corpus/measure.ts --json      # per-body JSON
//   npx tsx scripts/audit-probe/corpus/measure.ts --phrase    # phrase census
//   npx tsx scripts/audit-probe/corpus/measure.ts --list=<pat> # bodies matching

import { EMAIL_EXAMPLES } from "../../../src/lib/email-examples";
import volumeV from "../../../src/lib/email-examples-v5.json";

// ---------------------------------------------------------------------------
// Copied verbatim from scripts/draft-cli-eval.ts
// ---------------------------------------------------------------------------

const CONTRACTION =
  /\b(?:I|you|we|they|he|she|it|that|there|here|what|who|how|let|this|y'all)['’](?:m|re|ve|ll|d|s)\b|\b\w+n['’]t\b/gi;

const CANNED_LINES = {
  resumeLine: [
    /\bresume\b[^.!?]{0,40}\bfor your (?:reference|review|convenience|consideration)\b/i,
    /\bfor your (?:reference|review|convenience)\b[^.!?]{0,40}\bresume\b/i,
    /\bI(?:'ve| have| )?\s*attached (?:a copy of )?my resume\b/i,
    /\bmy resume(?:'s| is) attached\b/i,
    /\bplease (?:find|see)[^.!?]{0,20}\battached\b/i,
  ],
  flexibilityLine: [
    /\b(?:more than )?(?:happy|glad) to work around your schedule\b/i,
    /\bat your (?:earliest )?convenience\b/i,
    /\bwhatever (?:time |day |day or time )?works best for you\b/i,
    /\bwhenever (?:is |works )(?:most )?convenient\b/i,
    /\bI(?:'m| am) flexible (?:on|with|around) (?:timing|time|your schedule|whatever)\b/i,
    /\bany time that suits you works for me\b/i,
  ],
  easyOutLine: [
    /\bno (?:worries|pressure|problem)\b[^.!?]{0,40}\bif\b/i,
    /\bI (?:completely |totally |of course )?understand if\b/i,
    /\bif you(?:'re| are) (?:too )?busy\b/i,
    /\bno need to (?:reply|respond|apologi[sz]e)\b/i,
    /\bif (?:now|the timing)[^.!?]{0,25}\b(?:isn't|is not|doesn't|does not)\b/i,
  ],
} as const;

const PLEASANTRY =
  /^(?:[^.!?]{0,40}\b)?(?:I hope (?:this|you|your|all|things)|hope (?:you|this|all|your|things)|I trust you|how are you|hope all is well)\b/i;

function sentencesOf(text: string): string[] {
  return text
    .replace(/\s*\n\s*/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z“"])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function bodyParts(body: string): { greeting: string; text: string } {
  const lines = body.split("\n");
  const signOff = lines.map((l) => l.trim()).lastIndexOf("Best,");
  const aboveSignOff = (signOff >= 0 ? lines.slice(0, signOff) : lines).join("\n").trim();
  return {
    greeting: aboveSignOff.split("\n")[0]?.trim() ?? "",
    text: aboveSignOff.split("\n").slice(1).join("\n").trim(),
  };
}

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

// ---------------------------------------------------------------------------
// This probe's own additions
// ---------------------------------------------------------------------------

/** The literal phrases the plan is about, counted as occurrences, not bodies. */
const PHRASES: Record<string, RegExp> = {
  "for your reference": /for your reference/gi,
  "for your review": /for your review/gi,
  "for your convenience": /for your convenience/gi,
  "do not hesitate to": /do not hesitate to/gi,
  "don't hesitate to": /don['’]t hesitate to/gi,
  "I look forward to hearing from you": /I look forward to hearing from you/gi,
  "look forward to hearing": /look forward to hearing/gi,
  "I hope this email finds you well": /I hope this email finds you well/gi,
  "I hope you are doing well": /I hope you are doing well/gi,
  "happy to work around your schedule": /(?:more than )?happy to work around your schedule/gi,
  "Thank you for your time": /Thank you for your time/gi,
  "Thank you again": /Thank you again/gi,
  "Thank you so much": /Thank you so much/gi,
  "my name is": /\bmy name is\b/gi,
  "I wanted to": /\bI wanted to\b/gi,
  "please let me know if there is anything else": /please let me know if there is anything else/gi,
  "em dash": /—/g,
  "en dash": /–/g,
};

/** How the first sentence of the body opens. Mutually exclusive, in order. */
function openingType(first: string): string {
  if (!first) return "empty";
  if (PLEASANTRY.test(first)) return "pleasantry";
  if (/^(?:Thank you|Thanks|Thank-you)\b/i.test(first)) return "thanks";
  if (/^(?:It was |I really enjoyed|I enjoyed|Great |I appreciated|I loved)/i.test(first)) return "warm-reference";
  if (/^My name is\b/i.test(first)) return "self-intro";
  if (/^I(?:'m| am) (?:a |an |currently )/i.test(first)) return "self-intro";
  if (/^I\b|^I['’]/.test(first)) return "I-other";
  if (/^(?:Congratulations|Congrats)\b/i.test(first)) return "congrats";
  if (/^(?:Professor|Dr\.|Mr\.|Ms\.|Mrs\.)\s+[A-Z]/.test(first)) return "referrer-named";
  if (/^[A-Z][a-z]+ [A-Z][a-z]+(?:,| suggested| mentioned| passed| gave| recommended| told| said| put)/.test(first))
    return "referrer-named";
  if (/^(?:Would|Could|Do you|Are you|Is there|May I)\b/i.test(first)) return "question";
  if (/^(?:Following up|Circling back|A quick|Quick|Apologies|Sorry)\b/i.test(first)) return "direct";
  if (/^(?:Your|You|We )\b/.test(first)) return "recipient-first";
  return "other";
}

type Row = {
  corpus: "gold" | "v5";
  key: string;
  section?: number;
  boxes?: string[];
  note?: string;
  subject: string;
  words: number;
  sentences: number;
  contractions: number;
  contractionRate: number;
  zeroContractions: boolean;
  opening: string;
  firstSentence: string;
  longestIRun: number;
  threeIStarts: boolean;
  dashes: number;
  canned: { resumeLine: string | null; flexibilityLine: string | null; easyOutLine: string | null };
  cannedCount: number;
  closing: string;
  phrases: string[];
};

function measure(
  corpus: Row["corpus"],
  key: string,
  subject: string,
  body: string,
  extra: Partial<Row>,
): Row {
  const { text } = bodyParts(body);
  const sentences = sentencesOf(text);
  const words = countWords(text);
  const contractions = (text.match(CONTRACTION) ?? []).length;

  let longestIRun = 0;
  let run = 0;
  for (const s of sentences) {
    if (/^I\b|^I['’]/.test(s)) longestIRun = Math.max(longestIRun, ++run);
    else run = 0;
  }

  const canned = { resumeLine: null, flexibilityLine: null, easyOutLine: null } as Row["canned"];
  for (const [name, patterns] of Object.entries(CANNED_LINES) as [keyof typeof CANNED_LINES, readonly RegExp[]][]) {
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        canned[name] = m[0].trim();
        break;
      }
    }
  }

  const phrases: string[] = [];
  for (const [label, re] of Object.entries(PHRASES)) {
    const n = (text.match(re) ?? []).length;
    if (n) phrases.push(n > 1 ? `${label} x${n}` : label);
  }

  return {
    corpus,
    key,
    subject,
    words,
    sentences: sentences.length,
    contractions,
    contractionRate: words ? Number(((contractions / words) * 100).toFixed(2)) : 0,
    zeroContractions: contractions === 0,
    opening: openingType(sentences[0] ?? ""),
    firstSentence: sentences[0] ?? "",
    longestIRun,
    threeIStarts: longestIRun >= 3,
    dashes: (text.match(/[–—]/g) ?? []).length,
    canned,
    cannedCount: Object.values(canned).filter(Boolean).length,
    closing: sentences.length ? sentences[sentences.length - 1] : "",
    phrases,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const gold: Row[] = [];
for (const [typeId, examples] of Object.entries(
  EMAIL_EXAMPLES as Record<string, { note?: string; subject: string; body: string }[]>,
)) {
  examples.forEach((e, i) => {
    gold.push(measure("gold", `${typeId}#${i + 1}`, e.subject, e.body, { note: e.note }));
  });
}

const V5 = volumeV as { examples: { section: number; boxes: string[]; note?: string; subject: string; body: string }[] };
const v5: Row[] = V5.examples.map((e, i) =>
  measure("v5", `v5#${i + 1}`, e.subject, e.body, { section: e.section, boxes: e.boxes, note: e.note }),
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const arg = process.argv.slice(2);
const pct = (n: number, d: number) => `${n}/${d} (${((n / d) * 100).toFixed(1)}%)`;
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (xs: number[]) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) : 0);

if (arg.includes("--json")) {
  console.log(JSON.stringify({ gold, v5 }, null, 1));
} else if (arg.includes("--phrase")) {
  // Occurrence census across the gold corpus, with the bodies that carry each.
  for (const [label, re] of Object.entries(PHRASES)) {
    let occ = 0;
    const bodies: string[] = [];
    for (const [typeId, examples] of Object.entries(
      EMAIL_EXAMPLES as Record<string, { subject: string; body: string }[]>,
    )) {
      examples.forEach((e, i) => {
        const n = (bodyParts(e.body).text.match(re) ?? []).length;
        if (n) {
          occ += n;
          bodies.push(`${typeId}#${i + 1}${n > 1 ? `(x${n})` : ""}`);
        }
      });
    }
    console.log(`${occ.toString().padStart(3)} occ · ${bodies.length.toString().padStart(3)} bodies · ${label}`);
    if (arg.includes("--where")) console.log(`      ${bodies.join(" ")}`);
  }
} else if (arg.some((a) => a.startsWith("--list="))) {
  const pat = new RegExp(arg.find((a) => a.startsWith("--list="))!.slice(7), "i");
  for (const r of [...gold, ...v5]) {
    const { text } = bodyParts(
      r.corpus === "gold"
        ? (EMAIL_EXAMPLES as Record<string, { body: string }[]>)[r.key.split("#")[0]][Number(r.key.split("#")[1]) - 1]
            .body
        : V5.examples[Number(r.key.slice(3)) - 1].body,
    );
    for (const s of sentencesOf(text)) if (pat.test(s)) console.log(`${r.key}\t${s}`);
  }
} else {
  for (const [name, rows] of [
    ["GOLD (per-type examples: Volume II + III + IV)", gold],
    ["VOLUME V (combination examples)", v5],
  ] as const) {
    console.log(`\n===== ${name} — n = ${rows.length} =====\n`);
    const n = rows.length;
    console.log(`zero contractions in the whole email : ${pct(rows.filter((r) => r.zeroContractions).length, n)}`);
    console.log(`contractions   median ${med(rows.map((r) => r.contractions))}  mean ${mean(rows.map((r) => r.contractions))}  max ${Math.max(...rows.map((r) => r.contractions))}`);
    console.log(`rate /100w     median ${med(rows.map((r) => r.contractionRate))}  mean ${mean(rows.map((r) => r.contractionRate))}`);
    console.log(`words          median ${med(rows.map((r) => r.words))}  mean ${mean(rows.map((r) => r.words))}`);
    console.log(`opens on a pleasantry (harness PLEASANTRY) : ${pct(rows.filter((r) => r.opening === "pleasantry").length, n)}`);
    console.log(`3+ consecutive "I" openings                : ${pct(rows.filter((r) => r.threeIStarts).length, n)}`);
    console.log(`longest I-run  median ${med(rows.map((r) => r.longestIRun))}  mean ${mean(rows.map((r) => r.longestIRun))}  max ${Math.max(...rows.map((r) => r.longestIRun))}`);
    console.log(`em or en dash present                      : ${pct(rows.filter((r) => r.dashes > 0).length, n)}  (${rows.reduce((a, r) => a + r.dashes, 0)} occurrences)`);
    console.log(`any canned courtesy line                   : ${pct(rows.filter((r) => r.cannedCount > 0).length, n)}`);
    for (const k of ["resumeLine", "flexibilityLine", "easyOutLine"] as const) {
      console.log(`  ${k.padEnd(16)}                         : ${pct(rows.filter((r) => r.canned[k]).length, n)}`);
    }

    const openings = new Map<string, number>();
    for (const r of rows) openings.set(r.opening, (openings.get(r.opening) ?? 0) + 1);
    console.log(`\nopening type distribution`);
    for (const [k, v] of [...openings].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${v.toString().padStart(3)}  ${((v / n) * 100).toFixed(1).padStart(5)}%  ${k}`);
    }

    const closings = new Map<string, number>();
    for (const r of rows) closings.set(r.closing, (closings.get(r.closing) ?? 0) + 1);
    console.log(`\nclosing sentence: ${closings.size} distinct over ${n} bodies; the repeated ones`);
    for (const [k, v] of [...closings].sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 1)) {
      console.log(`  ${v.toString().padStart(3)}  ${JSON.stringify(k)}`);
    }

    const firsts = new Map<string, number>();
    for (const r of rows) firsts.set(r.firstSentence, (firsts.get(r.firstSentence) ?? 0) + 1);
    const repeatedFirst = [...firsts].filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]);
    if (repeatedFirst.length) {
      console.log(`\nfirst sentence repeated verbatim`);
      for (const [k, v] of repeatedFirst) console.log(`  ${v.toString().padStart(3)}  ${JSON.stringify(k)}`);
    }
  }

  console.log(`\n===== PHRASE CENSUS (gold only, occurrences) =====\n`);
  for (const [label, re] of Object.entries(PHRASES)) {
    let occ = 0;
    let bodies = 0;
    for (const e of Object.values(EMAIL_EXAMPLES as Record<string, { body: string }[]>).flat()) {
      const k = (bodyParts(e.body).text.match(re) ?? []).length;
      if (k) {
        occ += k;
        bodies++;
      }
    }
    console.log(`  ${occ.toString().padStart(3)} occ in ${bodies.toString().padStart(3)} bodies   ${label}`);
  }
}
