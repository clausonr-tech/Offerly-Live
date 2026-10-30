import "server-only";

import { currentSpecialties, isSpecialtyOf } from "../question-bank/specialties";
import { defaultDifficultyFor } from "../question-bank/readiness";
import { CATEGORY_LABELS, QUIZ_CATEGORIES, type QuizCategory, type QuizDifficulty } from "../question-bank/types";
import { loadBehavioralCore, loadFallbackTechnical, loadTechnicalCandidates, type BankCandidate } from "./question-bank-db";
import { MODE_COMPOSITION, type DifficultyChoice, type InterviewMode } from "./types";

/**
 * Which five questions a video interview asks, drawn from the database bank
 * (interview_questions, via question-bank-db). This module never imports the
 * static authored bank - that is seed input only.
 *
 * Behavioral questions come from the stable core the bank marks
 * (is_behavioral_core, in rotation_priority order), so one sitting is
 * comparable with the next: the anchor ("tell me about yourself") opens every
 * interview, and the rest rotate least-recently-asked first. Technical
 * questions are drawn at random, weighted toward the student's own sectors,
 * specialties and level from onboarding.
 *
 * The ranking functions are pure over the rows they are given, and the
 * randomness is injected, so the tests can pin both.
 */

export type SelectedQuestion = {
  kind: "behavioral" | "technical";
  bankId: string;
  prompt: string;
  topic: string;
  category: QuizCategory | null;
  difficulty: QuizDifficulty;
};

/** What onboarding told us, as the users row stores it. */
export type SelectionProfile = {
  preferredCategories?: string[] | null;
  nicheInterests?: string[] | null;
  targetGroup?: string | null;
  technicalReadiness?: string | null;
};

export type Targeting = {
  categories: QuizCategory[];
  specialties: Partial<Record<QuizCategory, string[]>>;
  difficulty: QuizDifficulty;
  /** True when no sector came from the student and a default was used. */
  fellBack: boolean;
  description: string;
};

/** The sector a student's free-text target group names, if any. */
export function categoryFromTargetGroup(targetGroup: string | null | undefined): QuizCategory | null {
  if (!targetGroup) return null;
  const t = targetGroup.toLowerCase();
  for (const c of QUIZ_CATEGORIES) if (CATEGORY_LABELS[c].toLowerCase() === t) return c;
  const hints: [RegExp, QuizCategory][] = [
    [/\b(ib|investment bank|m&a|advisory|coverage|capital markets|ecm|dcm|lev ?fin)/, "investment_banking"],
    [/\b(pe|private equity|buyout|lbo)\b/, "private_equity"],
    [/\b(vc|venture)/, "venture_capital"],
    [/private credit|direct lending|mezz/, "private_credit"],
    [/real estate|reit/, "real_estate"],
    [/hedge fund|long\/short|macro/, "hedge_fund"],
    [/sales|trading|s&t|markets desk/, "sales_trading"],
    [/asset management|wealth|portfolio management/, "asset_wealth_management"],
    [/commercial bank|corporate bank/, "commercial_banking"],
    [/insurance|actuar/, "insurance"],
    [/fintech|payments/, "fintech"],
    [/exchange|clearing|market infrastructure/, "market_infrastructure"],
    [/consult/, "consulting"],
    [/corporate finance|fp&a|treasury/, "other_finance"],
  ];
  for (const [re, c] of hints) if (re.test(t)) return c;
  return null;
}

/**
 * The sectors, specialties and level the technicals are drawn for.
 *
 * Sectors: the onboarding picks; else the target group's sector; else
 * investment banking's general questions, the most common first round, and
 * the page says so rather than implying it was tailored.
 */
export function resolveTargeting(profile: SelectionProfile, choice: DifficultyChoice): Targeting {
  const picked = (profile.preferredCategories ?? []).filter((c): c is QuizCategory => QUIZ_CATEGORIES.includes(c as QuizCategory));
  let categories = [...new Set(picked)];
  let fellBack = false;
  if (categories.length === 0) {
    const fromTarget = categoryFromTargetGroup(profile.targetGroup);
    if (fromTarget) categories = [fromTarget];
  }
  if (categories.length === 0) {
    categories = ["investment_banking"];
    fellBack = true;
  }

  // A specialty counts only inside a sector in the interview.
  const specialties: Partial<Record<QuizCategory, string[]>> = {};
  for (const niche of currentSpecialties(profile.nicheInterests)) {
    for (const c of categories) {
      if (isSpecialtyOf(c, niche)) (specialties[c] ??= []).push(niche);
    }
  }

  const difficulty: QuizDifficulty = choice !== "auto" ? choice : (defaultDifficultyFor(profile.technicalReadiness) ?? "intermediate");

  const sectorText = categories.map((c) => CATEGORY_LABELS[c]).join(", ");
  const specText = Object.values(specialties).flat();
  const description = fellBack
    ? "General finance technicals - add your sectors in your profile to tailor them."
    : `${sectorText}${specText.length ? ` (${specText.slice(0, 3).join(", ")})` : ""}`;

  return { categories, specialties, difficulty, fellBack, description };
}

const DIFFICULTY_ORDER: QuizDifficulty[] = ["foundational", "intermediate", "advanced"];

/**
 * How well a technical question fits: relevance first (the student's own
 * specialty, then their sector's general questions, then the rest of the
 * sector), level second, and a heavy penalty for anything asked recently.
 */
export function relevanceWeight(q: BankCandidate, targeting: Targeting, recentlyAsked: ReadonlySet<string>): number {
  const category = q.category as QuizCategory;
  if (!targeting.categories.includes(category)) return 0;
  const specs = targeting.specialties[category] ?? [];
  // Per question, so these have to outweigh pool SIZE too: banking has
  // thirteen other specialties' worth of questions for every one the student
  // picked, and at even weights those would crowd theirs out.
  let fit: number;
  if (q.specialty && specs.includes(q.specialty)) fit = 10;
  else if (!q.specialty) fit = specs.length > 0 ? 2 : 6;
  else fit = specs.length > 0 ? 0.05 : 2; // someone else's specialty

  const gap = Math.abs(DIFFICULTY_ORDER.indexOf(q.difficulty) - DIFFICULTY_ORDER.indexOf(targeting.difficulty));
  const level = gap === 0 ? 1 : gap === 1 ? 0.25 : 0.02;

  const fresh = recentlyAsked.has(q.id) ? 0.001 : 1;
  const boost = 1 + Math.max(0, Math.min(10, q.rotationPriority)) * 0.1;
  return fit * level * fresh * boost;
}

type Rng = () => number;

/** Weighted draw without replacement; spreads topics when it can. */
function weightedDraw(candidates: { item: BankCandidate; weight: number }[], count: number, rng: Rng) {
  const pool = candidates.filter((c) => c.weight > 0);
  const out: typeof pool = [];
  const topics = new Set<string>();
  while (out.length < count && pool.length > 0) {
    const fresh = pool.filter((c) => !topics.has(c.item.topic));
    const from = fresh.length > 0 ? fresh : pool;
    const total = from.reduce((s, c) => s + c.weight, 0);
    let r = rng() * total;
    let pick = from[from.length - 1];
    for (const c of from) {
      r -= c.weight;
      if (r <= 0) {
        pick = c;
        break;
      }
    }
    out.push(pick);
    topics.add(pick.item.topic);
    pool.splice(pool.indexOf(pick), 1);
  }
  return out;
}

const toSelected = (q: BankCandidate): SelectedQuestion => ({
  kind: q.kind,
  bankId: q.id,
  prompt: q.prompt,
  topic: q.topic,
  category: q.kind === "technical" ? (q.category as QuizCategory) : null,
  difficulty: q.difficulty,
});

/**
 * Technical questions from the candidate rows. `fallback` tops a thin sector
 * up (investment banking's general questions) so an interview is never short.
 */
export function rankTechnical(
  candidates: BankCandidate[],
  fallback: BankCandidate[],
  targeting: Targeting,
  count: number,
  recentlyAsked: ReadonlySet<string>,
  rng: Rng = Math.random,
): SelectedQuestion[] {
  if (count <= 0) return [];
  const technical = candidates.filter((q) => q.kind === "technical");
  let picked = weightedDraw(
    technical.map((q) => ({ item: q, weight: relevanceWeight(q, targeting, recentlyAsked) })),
    count,
    rng,
  );
  if (picked.length < count) {
    const have = new Set(picked.map((p) => p.item.id));
    const extra = fallback
      .filter((q) => q.kind === "technical" && !have.has(q.id))
      .map((q) => ({ item: q, weight: recentlyAsked.has(q.id) ? 0.001 : 1 }));
    picked = [...picked, ...weightedDraw(extra, count - picked.length, rng)];
  }
  return picked.map((p) => toSelected(p.item));
}

/**
 * The behavioral questions: the anchor (lowest rotation priority), then the
 * rest of the core, never-asked first, then least recently asked, ties in
 * rotation order. `lastAsked` maps a bank id to when the student last had it.
 */
export function rankBehavioral(core: BankCandidate[], count: number, lastAsked: ReadonlyMap<string, number>): SelectedQuestion[] {
  const ordered = core
    .filter((q) => q.kind === "behavioral")
    .sort((a, b) => a.rotationPriority - b.rotationPriority || a.id.localeCompare(b.id));
  if (count <= 0 || ordered.length === 0) return [];
  const [anchor, ...rest] = ordered;
  const rotated = rest
    .map((q, order) => ({ q, order }))
    .sort((a, b) => (lastAsked.get(a.q.id) ?? -1) - (lastAsked.get(b.q.id) ?? -1) || a.order - b.order)
    .map((x) => x.q);
  return [anchor, ...rotated].slice(0, count).map(toSelected);
}

/** The whole interview, in the order it is asked (behavioral first), read
 *  from the database bank. */
export async function selectInterviewQuestions(input: {
  mode: InterviewMode;
  targeting: Targeting;
  recentTechnicalIds: ReadonlySet<string>;
  behavioralLastAsked: ReadonlyMap<string, number>;
  rng?: Rng;
}): Promise<SelectedQuestion[]> {
  const { behavioral, technical } = MODE_COMPOSITION[input.mode];
  const [core, candidates, fallback] = await Promise.all([
    behavioral > 0 ? loadBehavioralCore() : Promise.resolve([]),
    technical > 0 ? loadTechnicalCandidates(input.targeting.categories) : Promise.resolve([]),
    technical > 0 ? loadFallbackTechnical() : Promise.resolve([]),
  ]);
  return [
    ...rankBehavioral(core, behavioral, input.behavioralLastAsked),
    ...rankTechnical(candidates, fallback, input.targeting, technical, input.recentTechnicalIds, input.rng),
  ];
}
