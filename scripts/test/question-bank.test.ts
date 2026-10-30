// The interview question bank, as the practice round serves it.
//
// The bank is generated (scripts/import-question-bank.ts) and large, so these
// check the promises a student actually feels: every question is filed under a
// specialty that exists, a round never repeats itself, nothing picks a sector
// for them, and the bank never ships to the browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  BEHAVIORAL_BANK,
  QUESTION_BANK,
  behavioralPool,
  questionPools,
} from "../../src/lib/technical-question-bank";
import { generatePracticeQuestion, type RoundConfig } from "../../src/lib/practice-session";
import { QUIZ_SPECIALTIES, RETIRED_SPECIALTIES, currentSpecialties } from "../../src/lib/question-bank/specialties";
import { QUIZ_CATEGORIES, QUIZ_DIFFICULTIES, ROUND_LENGTH } from "../../src/lib/question-bank/types";
import { NICHE_SECTOR_GROUPS } from "../../src/lib/niche-sectors";
import { CATEGORY_LABELS } from "../../src/lib/firm-metadata";

test("the bank is loaded: every sector has technical questions", () => {
  for (const c of QUIZ_CATEGORIES) assert.ok(QUESTION_BANK[c].length > 0, c);
  assert.ok(BEHAVIORAL_BANK.some((q) => !q.sector), "universal behaviorals are there");
});

test("every question's specialty is one the site offers, exactly", () => {
  for (const c of QUIZ_CATEGORIES) {
    for (const q of QUESTION_BANK[c]) {
      if (q.specialty) assert.ok(QUIZ_SPECIALTIES[c].includes(q.specialty), `${q.id}: "${q.specialty}"`);
    }
  }
  for (const q of BEHAVIORAL_BANK) {
    if (q.specialty) assert.ok(q.sector && QUIZ_SPECIALTIES[q.sector].includes(q.specialty), `${q.id}`);
  }
});

test("every specialty has its own questions at every difficulty", () => {
  for (const c of QUIZ_CATEGORIES) {
    for (const s of QUIZ_SPECIALTIES[c]) {
      for (const d of QUIZ_DIFFICULTIES) {
        const n = QUESTION_BANK[c].filter((q) => q.specialty === s && q.difficulty === d).length;
        assert.ok(n >= ROUND_LENGTH, `${c}/${s}/${d}: ${n}`);
      }
    }
  }
});

test("no two technical questions share an id", () => {
  const ids = Object.values(QUESTION_BANK).flat().map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("a picked specialty comes first, then its sector's general questions", () => {
  const [picked, general] = questionPools("investment_banking", ["Restructuring"]);
  assert.ok(picked.length > 0 && picked.every((q) => q.specialty === "Restructuring"));
  assert.ok(general.length > 0 && general.every((q) => !q.specialty));
});

test("no specialty picked is the whole sector", () => {
  const pools = questionPools("private_credit");
  assert.equal(pools.length, 1);
  assert.equal(pools[0].length, QUESTION_BANK.private_credit.length);
});

async function mcRound(config: RoundConfig): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < ROUND_LENGTH; i++) {
    const q = await generatePracticeQuestion({ userId: "test", config, seenPrompts: seen });
    assert.equal(q.format, "multiple_choice", "never falls through to a paid written question");
    seen.push(q.prompt);
  }
  return seen;
}

test("a multiple-choice round never repeats, for every sector, specialty and difficulty", async () => {
  for (const c of QUIZ_CATEGORIES) {
    for (const specialties of [[], ...QUIZ_SPECIALTIES[c].map((s) => [s])]) {
      for (const d of QUIZ_DIFFICULTIES) {
        const prompts = await mcRound({
          mode: "technical",
          difficulty: d,
          categories: [c],
          specialties: { [c]: specialties },
          format: "multiple_choice",
        });
        assert.equal(new Set(prompts).size, ROUND_LENGTH, `${c}/${specialties[0] ?? "all"}/${d}`);
      }
    }
  }
});

test("a thin specialty tops up from its own sector, never another", async () => {
  // Economic & Financial Consulting has no advanced questions with options.
  const prompts = await mcRound({
    mode: "technical",
    difficulty: "advanced",
    categories: ["consulting"],
    specialties: { consulting: ["Economic & Financial Consulting"] },
    format: "multiple_choice",
  });
  const consulting = new Set(QUESTION_BANK.consulting.map((q) => q.prompt));
  for (const p of prompts) assert.ok(consulting.has(p), p);
});

test("a technical round with no sector is refused, never served from a default", async () => {
  await assert.rejects(
    generatePracticeQuestion({
      userId: "test",
      config: { mode: "technical", difficulty: "foundational", categories: [], specialties: {}, format: "multiple_choice" },
      seenPrompts: [],
    }),
  );
});

test("behavioral: no sector is the universal questions only", () => {
  const pool = behavioralPool([]);
  assert.ok(pool.length > 0);
  assert.ok(pool.every((q) => !q.sector));
});

test("behavioral: a sector adds its general questions, not its specialties'", () => {
  const pool = behavioralPool(["private_credit"]);
  assert.ok(pool.some((q) => q.sector === "private_credit" && !q.specialty));
  assert.ok(!pool.some((q) => q.specialty));
  assert.ok(!pool.some((q) => q.sector && q.sector !== "private_credit"));
});

test("behavioral: a picked specialty adds its own questions", () => {
  const pool = behavioralPool(["private_credit"], { private_credit: ["Direct Lending"] });
  assert.ok(pool.some((q) => q.specialty === "Direct Lending"));
  assert.ok(!pool.some((q) => q.specialty && q.specialty !== "Direct Lending"));
});

test("onboarding and the profile offer the same 14 sectors and specialties as the bank", () => {
  assert.equal(NICHE_SECTOR_GROUPS.length, QUIZ_CATEGORIES.length);
  for (const c of QUIZ_CATEGORIES) {
    const group = NICHE_SECTOR_GROUPS.find((g) => g.group === CATEGORY_LABELS[c]);
    assert.ok(group, `no group labelled "${CATEGORY_LABELS[c]}"`);
    assert.deepEqual(group.sectors, [...QUIZ_SPECIALTIES[c]]);
  }
});

test("a retired specialty is not offered, and its saved label reads as its replacement", () => {
  const offered = new Set(Object.values(QUIZ_SPECIALTIES).flat());
  for (const [old, replacement] of Object.entries(RETIRED_SPECIALTIES)) {
    assert.ok(!offered.has(old), `${old} is still offered`);
    assert.ok(offered.has(replacement), `${old} points at ${replacement}, which is not offered`);
    for (const c of QUIZ_CATEGORIES) {
      assert.ok(!QUESTION_BANK[c].some((q) => q.specialty === old), `technical questions still tagged ${old}`);
    }
    assert.ok(!BEHAVIORAL_BANK.some((q) => q.specialty === old), `behavioral questions still tagged ${old}`);
  }
  // Deduped: a student who had picked both keeps one.
  assert.deepEqual(currentSpecialties(["Media & Telecom", "TMT Coverage", "Restructuring"]), ["TMT Coverage", "Restructuring"]);
});

test("the practice page's client components never import the bank", () => {
  // lib/technical-question-bank is megabytes of questions; a client import
  // would ship all of it to every student's browser.
  for (const file of ["src/app/(app)/learn/PracticeSession.tsx", "src/app/(app)/learn/PlatformerGame.tsx"]) {
    const src = fs.readFileSync(file, "utf8");
    assert.ok(!src.includes("technical-question-bank\""), file);
  }
});
