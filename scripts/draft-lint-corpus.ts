// How often the automatic checks find anything, over every draft body kept offline.
//
//   npx tsx scripts/draft-lint-corpus.ts           the human report
//   npx tsx scripts/draft-lint-corpus.ts --json    the same numbers, for diffing against a baseline
//
// No API call, no database: draftChecks and fluencyIssues (src/lib/draft-lint.ts)
// are pure, so they can be run over stored bodies as often as anyone likes.
//
// The question this answers is one question only: if the review call were
// gated on "did the automatic checks find anything", how often would the gate
// open? It says nothing about whether the review pass is worth making - the
// review finds invented facts and misread connectors that no regex looks for.
// See the limits section at the bottom of the report.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMAIL_EXAMPLES } from "../src/lib/email-examples";
import type { EmailTypeId } from "../src/lib/draft-templates";
import { finishDraft, type DraftPromptInput } from "../src/lib/draft-prompt";
import { draftChecks } from "../src/lib/draft-lint";
import volumeV from "../src/lib/email-examples-v5.json";
import { sims } from "./draft-occasions-sim";

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "draft-fixtures");

type Draft = { subject: string; body: string; notes: string[] };

/** The "=== <id>" blocks the scenario and occasion fixtures are stored in. */
function parseDrafts(file: string): Map<string, Draft> {
  const parts = readFileSync(file, "utf8").split(/^=== (\d+)\s*$/m).slice(1);
  const out = new Map<string, Draft>();
  for (let i = 0; i < parts.length; i += 2) {
    const [subjectLine, ...rest] = parts[i + 1].replace(/^\n/, "").split("\n");
    const notesLine = rest[0]?.startsWith("Notes:") ? rest.shift()! : "";
    out.set(parts[i], {
      subject: subjectLine.replace(/^Subject:\s*/, ""),
      body: rest.join("\n").trim(),
      notes: notesLine ? notesLine.replace(/^Notes:\s*/, "").split(" | ").filter(Boolean) : [],
    });
  }
  return out;
}

/**
 * scripts/draft-scenarios.ts writes its prompts at import time, from
 * process.argv, rather than behind an `isMain` guard. Its 474 scenarios are
 * the only place the inputs behind scenario-drafts-474.txt exist, and running
 * the checks without the input a draft was written from would change what they
 * find, so it is imported with argv pointed at a throwaway file outside the
 * repository and its one line of output swallowed.
 */
async function scenarioInputs() {
  const tmp = mkdtempSync(join(tmpdir(), "draft-lint-corpus-"));
  const argv = process.argv;
  const log = console.log;
  process.argv = [argv[0], argv[1], join(tmp, "prompts.txt")];
  console.log = () => {};
  try {
    return (await import("./draft-scenarios")).scenarioInputs();
  } finally {
    console.log = log;
    process.argv = argv;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ what each finding is
//
// The checks return sentences written for a reviewer to read, so a count by
// kind has to put them back into buckets. Each pattern below is matched
// against the finding text; the order is the order draft-lint.ts applies them.
const KINDS: [string, RegExp][] = [
  ["long sentence", /^long sentence \(/],
  ['clauses strung with ", and"', /clauses strung together with/],
  ['"also" and "too" in one sentence', /^"also" and "too"/],
  ["connector that isn't a cause", /^connector that isn't a cause/],
  ['split "to then"', /^split "to then"/],
  ["common ground tacked onto a paragraph", /^common ground tacked onto a paragraph/],
  ["calls the student an alum", /calls the student an alum/],
  ["announces the common ground as a discovery", /announces the common ground as a discovery/],
  ['common ground doubled with "like you"', /common ground doubled or tacked on/],
  ['"both" doubled with "too"', /"both" doubled with/],
  ['thank-you joined with ", and"', /joined with ", and"/],
  ["congratulations after the ask", /^congratulations come after the ask/],
  ['too many sentences start "Thank you"', /sentences start "Thank you"/],
  ["double space", /^double space$/],
  ["space before punctuation", /^space before punctuation$/],
  ["repeated word", /^repeated word:/],
  ["sentence starts in lowercase", /^sentence starts in lowercase/],
  ["capital after a colon", /^capital after a colon/],
  ["relays an opinion nobody typed", /^relays an opinion nobody typed/],
  ["filler phrase", /^filler phrase:/],
  ["comma splice", /^comma splice before/],
  ["dash used as punctuation", /^dash used as punctuation/],
  ["class year already in the signature", /class year is already in the signature/],
];

const kindOf = (finding: string) => KINDS.find(([, re]) => re.test(finding))?.[0] ?? `unclassified: ${finding.slice(0, 40)}`;

/**
 * The checks draftChecks adds on top of fluencyIssues. Worth keeping apart:
 * the fluency checks are the ones calibrated on the playbook's own emails
 * (`npx tsx scripts/draft-occasions-sim.ts lint-examples`), and these are not -
 * the filler rule rejects the playbook's own "I hope this email finds you
 * well" on purpose.
 */
const BEYOND_FLUENCY = new Set([
  "filler phrase",
  "comma splice",
  "dash used as punctuation",
  "relays an opinion nobody typed",
  "class year already in the signature",
]);

// ------------------------------------------------------------------ the corpora

type Scored = { corpus: string; id: string; what: string; forReview: string[]; forStudent: string[] };

const GREETING = /^(?:Hi|Hello|Dear)\s+([^,]+),/;

async function score(): Promise<Scored[]> {
  const out: Scored[] = [];

  // 1. The multi-box situations: 87 drafts written for the prompts in
  // occasion-sims.txt, checked against the input each one was written from,
  // after finishDraft - exactly what the pipeline checks.
  const occasion = parseDrafts(join(FIXTURES, "occasion-drafts.txt"));
  for (const s of sims()) {
    const raw = occasion.get(s.id);
    if (!raw) continue;
    const final = finishDraft(s.input, { ...raw, connectionUsed: null, gaps: [], notesForStudent: raw.notes });
    const checks = draftChecks(s.input, final.body);
    out.push({ corpus: "multi-box situations", id: s.id, what: `${s.profile} · ${s.situation.summary}`, ...checks });
  }

  // 2. The scenario corpus: 474 drafts, one per scenario, every type covered.
  const scenarios = parseDrafts(join(FIXTURES, "scenario-drafts-474.txt"));
  for (const { scenario, input } of await scenarioInputs()) {
    const raw = scenarios.get(scenario.id);
    if (!raw) continue;
    const final = finishDraft(input, { ...raw, connectionUsed: null, gaps: [], notesForStudent: raw.notes });
    const checks = draftChecks(input, final.body);
    out.push({ corpus: "scenarios", id: scenario.id, what: `${scenario.type} · ${scenario.what}`, ...checks });
  }

  // 3. The playbook's own emails, which the checks are calibrated to pass.
  // These are finished emails, so finishDraft is not applied (it would rebuild
  // their signature from a profile that doesn't exist), and the input they
  // never had is reconstructed as the bare minimum the checks read: the name in
  // the greeting, so the greeting check doesn't misfire.
  const minimal = (contactName: string, type: EmailTypeId): Parameters<typeof draftChecks>[0] => ({
    contactName,
    contactFirm: null,
    gmailSignature: false,
    studentGradYear: null,
    brief: {},
    purpose: null,
    extraContext: "",
    type,
  }) as unknown as Pick<DraftPromptInput, "contactName" | "contactFirm" | "gmailSignature" | "studentGradYear" | "brief" | "purpose" | "extraContext">;

  for (const [typeId, examples] of Object.entries(EMAIL_EXAMPLES)) {
    examples.forEach((e, i) => {
      const name = e.body.match(GREETING)?.[1]?.trim() ?? "there";
      const checks = draftChecks(minimal(name, typeId as EmailTypeId), e.body);
      out.push({ corpus: "playbook examples (per type)", id: `${typeId}#${i + 1}`, what: e.note ?? typeId, ...checks });
    });
  }

  const V = volumeV as { examples: { section: number; boxes: string[]; subject: string; body: string }[] };
  V.examples.forEach((e, i) => {
    const name = e.body.match(GREETING)?.[1]?.trim() ?? "there";
    const checks = draftChecks(minimal(name, "custom"), e.body);
    out.push({ corpus: "playbook examples (Volume V combinations)", id: `v5#${i + 1}`, what: e.boxes.join("+"), ...checks });
  });

  return out;
}

// ------------------------------------------------------------------ the report

async function main() {
  const scored = await score();
  const corpora = [...new Set(scored.map((s) => s.corpus))];

  function summarise(rows: Scored[]) {
    const byKind = new Map<string, number>();
    const bodiesByKind = new Map<string, number>();
    for (const r of rows) {
      const kinds = new Set<string>();
      for (const f of r.forReview) {
        const k = kindOf(f);
        byKind.set(k, (byKind.get(k) ?? 0) + 1);
        kinds.add(k);
      }
      for (const k of kinds) bodiesByKind.set(k, (bodiesByKind.get(k) ?? 0) + 1);
    }
    const flagged = rows.filter((r) => r.forReview.length > 0);
    const fluencyFlagged = rows.filter((r) => r.forReview.some((f) => !BEYOND_FLUENCY.has(kindOf(f))));
    return {
      bodies: rows.length,
      bodiesWithFindings: flagged.length,
      shareWithFindings: rows.length ? flagged.length / rows.length : 0,
      bodiesWithFluencyFindings: fluencyFlagged.length,
      shareWithFluencyFindings: rows.length ? fluencyFlagged.length / rows.length : 0,
      findings: rows.reduce((n, r) => n + r.forReview.length, 0),
      findingsPerFlaggedBody: flagged.length ? rows.reduce((n, r) => n + r.forReview.length, 0) / flagged.length : 0,
      bodiesWithStudentNotes: rows.filter((r) => r.forStudent.length > 0).length,
      byKind: [...byKind]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, findings]) => ({
          kind,
          findings,
          bodies: bodiesByKind.get(kind) ?? 0,
          from: BEYOND_FLUENCY.has(kind) ? "draftChecks" : "fluencyIssues",
        })),
    };
  }

  const report = {
    harness: "scripts/draft-lint-corpus.ts",
    measures: "draftChecks(...).forReview over every draft body stored in the repository",
    overall: summarise(scored),
    byCorpus: Object.fromEntries(corpora.map((c) => [c, summarise(scored.filter((s) => s.corpus === c))])),
    modelWrittenOnly: summarise(scored.filter((s) => s.corpus === "multi-box situations" || s.corpus === "scenarios")),
    flagged: scored.filter((s) => s.forReview.length > 0).map((s) => ({ corpus: s.corpus, id: s.id, what: s.what, findings: s.forReview })),
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const line = (label: string, s: ReturnType<typeof summarise>) =>
      console.log(
        `  ${label.padEnd(42)} ${String(s.bodiesWithFindings).padStart(4)} / ${String(s.bodies).padEnd(4)} bodies  ${pct(s.shareWithFindings).padStart(6)}   ` +
          `${String(s.findings).padStart(4)} findings   ${pct(s.shareWithFluencyFindings).padStart(6)} on the fluency checks alone`,
      );

    console.log("THE AUTOMATIC CHECKS OVER EVERY DRAFT BODY KEPT OFFLINE");
    console.log("(forReview: what the review pass is handed to fix)\n");
    line("ALL", report.overall);
    for (const c of corpora) line(c, report.byCorpus[c]);
    console.log();
    line("model-written corpora only", report.modelWrittenOnly);
    console.log();

    console.log("WHICH CHECKS FIRE, over the model-written corpora (561 bodies)");
    console.log(`  ${"check".padEnd(44)}${"findings".padStart(9)}${"bodies".padStart(8)}`);
    for (const k of report.modelWrittenOnly.byKind) {
      console.log(`  ${k.kind.padEnd(44)}${String(k.findings).padStart(9)}${String(k.bodies).padStart(8)}   ${k.from}`);
    }
    console.log();

    console.log("THE PLAYBOOK'S OWN EMAILS - these are supposed to pass");
    for (const c of corpora.filter((x) => x.startsWith("playbook"))) {
      const s = report.byCorpus[c];
      console.log(`  ${c}: ${s.bodiesWithFindings} of ${s.bodies} flagged, ${s.findings} findings`);
      for (const k of s.byKind) console.log(`    ${k.kind} (${k.findings}, ${k.from})`);
    }
    console.log("  The fluency checks are the ones calibrated on these emails, and they are nearly silent here. What");
    console.log("  flags them is the rest of draftChecks: the filler rule rejects the playbook's own \"I hope this");
    console.log("  email finds you well\" by design, and \"relays an opinion nobody typed\" has no typed input to");
    console.log("  compare an example against, so on this corpus it is an artifact rather than a finding.");
    console.log();

    console.log("WHAT THIS CAN AND CANNOT TELL US");
    console.log("  Can: how often a lint gate on the review call would open, and which checks carry that rate.");
    console.log("  Cannot: whether the review pass is worth making. These bodies are stored fixtures, not live");
    console.log("  pipeline output: they were drafted once, for fixed simulated students, and a draft the review");
    console.log("  pass has already improved is not in here at all. The checks are regexes - the review finds");
    console.log("  invented facts, wrong people and misread connectors that no regex looks for, so an empty");
    console.log("  forReview list is not evidence that a draft is fine.");
  }
}

void main();
