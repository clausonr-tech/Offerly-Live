// Turns the authored question bank in question-bank-draft/ into the data files
// the app loads, one per sector, under src/lib/question-bank/data/.
//
//   npx tsx scripts/import-question-bank.ts
//
// question-bank-draft/ is the source of truth: fix a question there, run
// `python3 question-bank-draft/format.py` to keep it at one question per line,
// then run this. The draft layout is one file per sector and specialty (see
// question-bank-draft/GENERATION-PROMPT.md); the app wants one compact file per
// sector, with each question's specialty written onto it.
//
// Refuses to write anything if the bank is malformed - an unknown sector or
// specialty, a duplicate id, a question with the wrong number of options - so a
// broken regeneration never reaches students.

import fs from "node:fs";
import path from "node:path";
import { QUIZ_SPECIALTIES } from "../src/lib/question-bank/specialties";
import { QUIZ_CATEGORIES, type QuizCategory } from "../src/lib/question-bank/types";

const SOURCE = path.join(process.cwd(), "question-bank-draft");
const OUT = path.join(process.cwd(), "src/lib/question-bank/data");

const DIFFICULTIES = new Set(["foundational", "intermediate", "advanced"]);
const BEHAVIORAL_CATEGORIES = new Set([
  "Motivation",
  "Fit",
  "Teamwork",
  "Leadership",
  "Challenges",
  "Integrity",
  "Commercial Awareness",
  "Curveball",
]);

type Choices = { answer: string; distractors: string[] } | null | undefined;
type DraftTechnical = {
  id: string;
  topic: string;
  difficulty: string;
  prompt: string;
  expectedPoints: string[];
  choices?: Choices;
};
type DraftBehavioral = {
  id: string;
  category: string;
  difficulty: string;
  prompt: string;
  expectedPoints: string[];
};
type DraftFile = {
  sector: QuizCategory | null;
  specialty: string | null;
  technical?: DraftTechnical[];
  behavioral?: DraftBehavioral[];
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const problems: string[] = [];
const ids = new Set<string>();

function read(rel: string): DraftFile | null {
  const file = path.join(SOURCE, rel);
  if (!fs.existsSync(file)) {
    problems.push(`missing ${rel}`);
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as DraftFile;
}

function checkCommon(where: string, q: { id: string; prompt: string; difficulty: string; expectedPoints: string[] }) {
  if (ids.has(q.id)) problems.push(`${where}: duplicate id ${q.id}`);
  ids.add(q.id);
  if (!q.prompt?.trim()) problems.push(`${where}: ${q.id} has no prompt`);
  if (!DIFFICULTIES.has(q.difficulty)) problems.push(`${where}: ${q.id} difficulty "${q.difficulty}"`);
  if (!Array.isArray(q.expectedPoints) || q.expectedPoints.length < 3 || q.expectedPoints.length > 6) {
    problems.push(`${where}: ${q.id} has ${q.expectedPoints?.length ?? 0} expected points (3-6)`);
  }
}

function technical(where: string, q: DraftTechnical, specialty: string | null) {
  checkCommon(where, q);
  if (!q.topic?.trim()) problems.push(`${where}: ${q.id} has no topic`);
  const c = q.choices;
  if (c) {
    const options = [c.answer, ...(c.distractors ?? [])].map((o) => o?.trim().toLowerCase());
    if (!c.answer || c.distractors?.length !== 3) problems.push(`${where}: ${q.id} needs one answer and three distractors`);
    else if (new Set(options).size !== 4) problems.push(`${where}: ${q.id} repeats an option`);
  }
  return {
    id: q.id,
    topic: q.topic,
    difficulty: q.difficulty,
    prompt: q.prompt,
    expectedPoints: q.expectedPoints,
    ...(c ? { choices: { answer: c.answer, distractors: c.distractors } } : {}),
    ...(specialty ? { specialty } : {}),
  };
}

function behavioral(where: string, q: DraftBehavioral, specialty: string | null) {
  checkCommon(where, q);
  if (!BEHAVIORAL_CATEGORIES.has(q.category)) problems.push(`${where}: ${q.id} category "${q.category}"`);
  return {
    id: q.id,
    category: q.category,
    difficulty: q.difficulty,
    prompt: q.prompt,
    expectedPoints: q.expectedPoints,
    ...(specialty ? { specialty } : {}),
  };
}

const sectors: Record<string, { technical: unknown[]; behavioral: unknown[] }> = {};
for (const sector of QUIZ_CATEGORIES) {
  const out = { technical: [] as unknown[], behavioral: [] as unknown[] };
  const files: [string, string | null][] = [
    [`${sector}/_general.json`, null],
    ...QUIZ_SPECIALTIES[sector].map((s): [string, string | null] => [`${sector}/${slug(s)}.json`, s]),
  ];
  for (const [rel, specialty] of files) {
    const draft = read(rel);
    if (!draft) continue;
    if (draft.sector !== sector) problems.push(`${rel}: sector is "${draft.sector}", expected "${sector}"`);
    if (draft.specialty !== specialty) problems.push(`${rel}: specialty is "${draft.specialty}", expected "${specialty}"`);
    for (const q of draft.technical ?? []) out.technical.push(technical(rel, q, specialty));
    for (const q of draft.behavioral ?? []) out.behavioral.push(behavioral(rel, q, specialty));
  }
  sectors[sector] = out;
}

const universalDraft = read("_universal/behavioral.json");
const universal = (universalDraft?.behavioral ?? []).map((q) => behavioral("_universal/behavioral.json", q, null));
if ((universalDraft?.technical ?? []).length > 0) problems.push("_universal/behavioral.json: holds technical questions");

if (problems.length > 0) {
  console.error(`Not imported - ${problems.length} problem(s):`);
  for (const p of problems.slice(0, 50)) console.error(`  ${p}`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
let technicalCount = 0;
let behavioralCount = universal.length;
for (const [sector, data] of Object.entries(sectors)) {
  fs.writeFileSync(path.join(OUT, `${sector}.json`), JSON.stringify(data) + "\n");
  technicalCount += data.technical.length;
  behavioralCount += data.behavioral.length;
}
fs.writeFileSync(path.join(OUT, "universal-behavioral.json"), JSON.stringify({ behavioral: universal }) + "\n");

console.log(
  `imported ${technicalCount} technical and ${behavioralCount} behavioral questions ` +
    `(${technicalCount + behavioralCount} total) into ${path.relative(process.cwd(), OUT)}`,
);
