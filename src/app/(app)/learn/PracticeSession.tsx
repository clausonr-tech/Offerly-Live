"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import {
  Flame,
  Trophy,
  Play,
  RotateCcw,
  ChevronRight,
  ChevronDown,
  Target,
  Calculator,
  MessageSquare,
  Shuffle,
  Sparkles,
  Zap,
} from "lucide-react";
import {
  getPracticeQuestion,
  submitPracticeAnswer,
  completePracticeRound,
} from "./practice-actions";
// The client-safe vocabulary only - never lib/technical-question-bank, which
// would ship the whole question bank to the browser.
import {
  CATEGORY_LABELS,
  QUIZ_CATEGORIES,
  GRADING_LEVEL_LABELS,
  DIFFICULTY_LABELS,
  type QuizCategory,
} from "@/lib/question-bank/types";
import { QUIZ_SPECIALTIES } from "@/lib/question-bank/specialties";
import { industryLabel, sectorLabel } from "@/lib/question-bank/picker-labels";
import {
  FORMAT_LABELS,
  PRACTICE_FORMATS,
  ROUND_LENGTH,
  type PracticeFormat,
} from "@/lib/question-bank/types";
import type { PracticeQuestion, PracticeMode, RoundDifficulty, RoundSummary } from "@/lib/practice-session";
import type { Grade } from "@/lib/grading";
import PlatformerGame from "./PlatformerGame";

type Stats = {
  personalBest: number;
  currentStreak: number;
  bestStreak: number;
  roundsPlayed: number;
};

type GradeResult = Grade & { currentStreak: number; bestStreak: number };

// The same "digital" identity as the platformer game, but theme-aware: these
// read the CSS custom properties defined in globals.css under [data-app-theme]
// (light, default) and [data-app-theme="terminal"] (dark, the game's own
// navy/cream palette) - so the whole Interview Prep page relights with the
// site's own theme toggle instead of being stuck in one mode. The game screen
// itself stays fixed regardless - see the comment above those CSS variables.
const BG = "var(--learn-bg)";
const PANEL = "var(--learn-panel)";
const SELECTED_BG = "var(--learn-selected-bg)";
const PASS_BG = "var(--learn-pass-bg)";
const FAIL_BG = "var(--learn-fail-bg)";
const CREAM = "var(--learn-fg)";
const MUTED = "var(--learn-muted)";
const BORDER = "var(--learn-border)";
const CYAN = "var(--learn-cyan)";
const RED = "var(--learn-red)";
const GOLD = "var(--learn-gold)";
const ROSE = "var(--learn-rose)";

const MODES: {
  value: PracticeMode;
  label: string;
  icon: typeof Calculator;
  accent: string;
}[] = [
  {
    value: "technical",
    label: "Technical",
    icon: Calculator,
    accent: CYAN,
  },
  {
    value: "behavioral",
    label: "Behavioral",
    icon: MessageSquare,
    accent: ROSE,
  },
  {
    value: "mixed",
    label: "Mixed",
    icon: Shuffle,
    accent: GOLD,
  },
];

const DIFFICULTIES: { value: RoundDifficulty; label: string; accent: string }[] = [
  { value: "foundational", label: "Beginner", accent: CYAN },
  { value: "intermediate", label: "Intermediate", accent: GOLD },
  { value: "advanced", label: "Advanced", accent: RED },
  { value: "mixed", label: "Surprise me", accent: CREAM },
];

// Streak tiers, so a run visibly escalates instead of just counting up.
function streakTier(n: number) {
  if (n >= 8) return { label: "BLAZING", color: RED };
  if (n >= 5) return { label: "ON FIRE", color: GOLD };
  if (n >= 2) return { label: "HEATING UP", color: GOLD };
  return null;
}

function band(score: number) {
  if (score >= 85) return { label: "Interview ready", tone: CYAN };
  if (score >= 70) return { label: "Solid", tone: CYAN };
  if (score >= 50) return { label: "Getting there", tone: GOLD };
  return { label: "Needs work", tone: RED };
}

const BTN = "inline-flex items-center gap-2 border font-semibold disabled:opacity-50";
// One option in a setup row. min-h-10 keeps each option a comfortable target
// on a phone. flex-auto: each option grows from its own label
// width, so a group runs edge to edge across its column without squeezing a
// long label ("INTERMEDIATE") to fit a short one's share.
//
// Sized by the setup frame's width (@container, on the setup wrapper), not the
// window's: the rail beside the page is 240px open and 68px retracted, so the
// same window leaves very different room. Pixel thresholds, not @4xl/@5xl:
// this app's root font is 17px, so rem-based container sizes land later than
// their names suggest. Measured, not guessed: Difficulty's four options need
// about 1015px of frame at 10px labels (hence 1040px) and about 817px at 8px
// (hence 860px, where the two columns start).
const SEGMENT =
  "inline-flex min-h-10 flex-auto items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-3 py-2 text-sm font-medium";
// The two-column grid the setup rows share, so Questions and Industry line up
// under Format and Difficulty, and Start sits beside Sector. 2fr/3fr, not
// halves: Difficulty has four options to Format's three, and equal halves left
// it too narrow to hold them on one line.
const SETUP_GRID = "grid gap-x-6 @min-[860px]:grid-cols-[2fr_3fr] @min-[1040px]:gap-x-10";

/** Tall enough to show an industry's sectors without much scrolling. */
const MENU_MAX_H = 360;

/**
 * One of the setup screen's pixel dropdowns: a bordered trigger, and a list
 * that drops from it.
 *
 * The list is portalled to [data-app-theme], not left in place: the setup
 * screen's outer frame clips at overflow-hidden (the pixel-device border
 * look), which cut a long list off partway down whatever the panel's own
 * overflow said. [data-app-theme], not document.body, because the --learn-*
 * colours are scoped to it (see PersonMenu.tsx for the same reasoning). Being
 * portalled, it is placed by measuring the trigger, flips above it when there
 * is no room below, and re-applies the pixel font, which does not cross a
 * portal on its own.
 */
function PixelMenu({
  label,
  open,
  onToggle,
  onClose,
  disabled = false,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const openUp = below < MENU_MAX_H && r.top > below;
    setPos({ top: openUp ? Math.max(8, r.top - MENU_MAX_H - 4) : r.bottom + 4, left: r.left, width: r.width });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // Closes on an outside click, checking the portalled panel too - it is no
  // longer a DOM descendant of the trigger.
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t) || panelRef.current?.contains(t)) return;
      onClose();
    }
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place, onClose]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-expanded={open}
        className="flex min-h-10 w-full items-center justify-between gap-3 rounded-md border bg-[#ffffff] px-3 py-2 text-left text-sm disabled:opacity-50"
        style={{ borderColor: open ? CREAM : BORDER, color: CREAM }}
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={12} color={MUTED} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: MENU_MAX_H, borderColor: BORDER }}
            className="fixed z-50 overflow-y-auto rounded-md border bg-[#ffffff] shadow-card"
          >
            {children}
          </div>,
          document.querySelector<HTMLElement>("[data-app-theme]") ?? document.body,
        )}
    </div>
  );
}

export default function PracticeSession({ initialStats }: { initialStats: Stats }) {
  const [phase, setPhase] = useState<"setup" | "answering" | "graded" | "summary" | "game">("setup");
  const [stats, setStats] = useState(initialStats);

  const [mode, setMode] = useState<PracticeMode>("technical");
  const [difficulty, setDifficulty] = useState<RoundDifficulty>("intermediate");
  const [format, setFormat] = useState<PracticeFormat>("written");
  // Starts empty, always. Nothing - not the student's saved sectors, not an
  // interview prompt, not a default - chooses the sector for them: a guess
  // they did not notice meant a round of the wrong desk's questions. A
  // technical or mixed round cannot start until they pick one.
  const [categories, setCategories] = useState<QuizCategory[]>([]);
  // Per sector, the specialties it is narrowed to. Absent or empty is the whole
  // sector - the "All" row in its list.
  const [specialties, setSpecialties] = useState<Partial<Record<QuizCategory, string[]>>>({});
  // Which of the two dropdowns is open - Industry, or Sector under it.
  const [openMenu, setOpenMenu] = useState<"industry" | "sector" | null>(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);

  const [questionNumber, setQuestionNumber] = useState(0);
  const [score, setScore] = useState(0);
  const [roundStreak, setRoundStreak] = useState(0);
  const [seenPrompts, setSeenPrompts] = useState<string[]>([]);
  const [results, setResults] = useState<boolean[]>([]);
  // One signed receipt per graded answer. The round is saved from these, so
  // its score is the server's count, not a number this page sends.
  const [receipts, setReceipts] = useState<string[]>([]);

  const [question, setQuestion] = useState<PracticeQuestion | null>(null);
  const [answer, setAnswer] = useState("");
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [summary, setSummary] = useState<{
    score: number;
    personalBest: number;
    isPersonalBest: boolean;
    bestStreak: number;
  } | null>(null);

  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();
  const [roundsThisSitting, setRoundsThisSitting] = useState(0);
  const [sittingPoints, setSittingPoints] = useState(0);

  const config = { mode, difficulty, categories, specialties, format };
  const needsSector = mode !== "behavioral";
  const missingSector = needsSector && categories.length === 0;
  const activeMode = MODES.find((m) => m.value === mode)!;

  // An industry in the Industry box is in the round or not. Taking one out
  // forgets whatever sectors it was narrowed to.
  function toggleCategory(c: QuizCategory) {
    const on = categories.includes(c);
    setCategories((prev) => (on ? prev.filter((x) => x !== c) : [...prev, c]));
    if (on) setSpecialties((prev) => ({ ...prev, [c]: [] }));
  }

  function toggleSpecialty(c: QuizCategory, specialty: string) {
    setSpecialties((prev) => {
      const current = prev[c] ?? [];
      const next = current.includes(specialty)
        ? current.filter((x) => x !== specialty)
        : [...current, specialty];
      return { ...prev, [c]: next };
    });
  }

  // What the two boxes say - lib/question-bank/picker-labels.
  const industryText = industryLabel(categories, needsSector);
  const sectorText = sectorLabel(categories, specialties);

  function loadQuestion(nextSeen: string[]) {
    setError("");
    setGrade(null);
    setAnswer("");
    setQuestion(null);
    startTransition(async () => {
      const result = await getPracticeQuestion(config, nextSeen);
      if (result.error) {
        setError(result.error);
        setPhase("setup");
      } else if (result.question) {
        setQuestion(result.question);
        setPhase("answering");
      }
    });
  }

  function startRound() {
    if (missingSector) {
      setError("Pick at least one sector.");
      return;
    }
    // Technical + multiple choice is the format that made a game screen
    // possible in the first place: it's already marked deterministically, so
    // "right" and "wrong" are known the instant an option is clicked, with no
    // grading delay to break the platform-jump feel. The game screen owns its
    // own round loop entirely - see PlatformerGame.
    if (mode === "technical" && format === "multiple_choice") {
      setError("");
      setPhase("game");
      return;
    }
    setQuestionNumber(1);
    setScore(0);
    setRoundStreak(0);
    setSeenPrompts([]);
    setResults([]);
    setReceipts([]);
    setSummary(null);
    loadQuestion([]);
  }

  function handleSubmit() {
    if (!question || !answer.trim() || isPending) return;
    setError("");
    startTransition(async () => {
      const result = await submitPracticeAnswer(question, answer);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (!result.grade) return;

      const g = result.grade;
      setGrade(g);
      setScore((s) => s + g.points);
      setSeenPrompts((s) => [...s, question.prompt]);
      setResults((r) => [...r, g.passed]);
      setReceipts((r) => [...r, g.receipt]);
      setStats((s) => ({ ...s, currentStreak: g.currentStreak, bestStreak: g.bestStreak }));

      const next = g.passed ? roundStreak + 1 : 0;
      setRoundStreak(next);
      setPhase("graded");
    });
  }

  function handleNext() {
    if (questionNumber >= ROUND_LENGTH) {
      const finalScore = score;
      startTransition(async () => {
        const result = await completePracticeRound(config, receipts);
        if (result.summary) {
          setSummary(result.summary);
          setStats((s) => ({
            ...s,
            personalBest: result.summary!.personalBest,
            roundsPlayed: s.roundsPlayed + 1,
          }));
        }
        setRoundsThisSitting((n) => n + 1);
        setSittingPoints((p) => p + (result.summary?.score ?? finalScore));
        setPhase("summary");
      });
      return;
    }
    setQuestionNumber((n) => n + 1);
    loadQuestion(seenPrompts);
  }

  const handlers = useRef({ handleSubmit, handleNext, startRound });
  useEffect(() => {
    handlers.current = { handleSubmit, handleNext, startRound };
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const isTyping =
        el?.tagName === "TEXTAREA" || el?.tagName === "INPUT" || el?.isContentEditable;

      if (isTyping) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handlers.current.handleSubmit();
        }
        return;
      }
      // Enter only. Space used to do this too, which swallowed Space
      // everywhere on the page - so Space could never scroll it.
      if (e.key !== "Enter") return;
      if (el?.tagName === "BUTTON" || el?.tagName === "A" || el?.tagName === "SELECT" || el?.closest("[role=listbox],[role=menu]")) return;

      e.preventDefault();
      if (phase === "graded") handlers.current.handleNext();
      else if (phase === "summary" || phase === "setup") handlers.current.startRound();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase]);

  const tier = streakTier(roundStreak);

  if (phase === "game") {
    return (
      <PlatformerGame
        categories={categories}
        specialties={specialties}
        difficulty={difficulty}
        initialCurrentStreak={stats.currentStreak}
        initialBestStreak={stats.bestStreak}
        onExit={() => setPhase("setup")}
        onStreakUpdate={(currentStreak, bestStreak) =>
          setStats((s) => ({ ...s, currentStreak, bestStreak }))
        }
        onRoundComplete={(roundSummary: RoundSummary) => {
          setStats((s) => ({
            ...s,
            personalBest: roundSummary.personalBest,
            roundsPlayed: s.roundsPlayed + 1,
          }));
          setRoundsThisSitting((n) => n + 1);
          setSittingPoints((p) => p + roundSummary.score);
        }}
      />
    );
  }

  return (
    <div
      data-interactive
      // Natural height on every screen. The setup menu sits at the top of the
      // page and the school leaderboard below it takes the rest of the board
      // (page.tsx), so the spare height goes to the board that will fill it
      // rather than to blank space around the menu.
      className="list-panel flex flex-col overflow-hidden border border-brand-100 text-[var(--learn-fg)]"
    >
      {/* ───────── records bar ───────── */}
      <div
        // Tighter on the setup screen only (see the body below); the round
        // screens keep the bar as it was.
        className={`flex flex-wrap items-center gap-x-5 border-b ${
          phase === "setup" ? "gap-y-1.5 px-4 py-1.5" : "gap-y-2 px-5 py-3"
        }`}
        style={{ borderColor: BORDER, background: PANEL }}
      >
        <Stat icon={<Trophy size={13} />} label="Best round" value={`${stats.personalBest}`} suffix="/100" tone={GOLD} />
        <Stat icon={<Flame size={13} />} label="Streak" value={String(stats.currentStreak)} tone={RED} />
        <Stat icon={<Target size={13} />} label="Best streak" value={String(stats.bestStreak)} tone={CYAN} />
        {stats.roundsPlayed > 0 && (
          <span className="ml-auto text-xs" style={{ color: MUTED }}>
            {stats.roundsPlayed} round{stats.roundsPlayed === 1 ? "" : "s"} played
          </span>
        )}
      </div>

      <div className={phase === "setup" ? "px-4 py-4 lg:px-6 lg:py-6" : "p-5"}>
        {/* ───────── setup ───────── */}
        {phase === "setup" && (
          // Top-aligned, full width: Format and Difficulty first, Questions
          // and Industry under them, then Start. Every row spans the page
          // rather than sitting as a small menu centred in a large frame.
          <div className="@container flex flex-col gap-y-5 @min-[1040px]:gap-y-7">
            {/* Format beside difficulty, question format beside industry,
                across the whole frame. Stacks in a narrow frame. */}
            <div className={`${SETUP_GRID} gap-y-4 @min-[1040px]:gap-y-7`}>
              <div>
                <SectionLabel>Format</SectionLabel>
                <div className="flex flex-wrap gap-1.5 @min-[860px]:flex-nowrap @min-[1040px]:gap-2">
                  {MODES.map((m) => {
                    const on = mode === m.value;
                    const Icon = m.icon;
                    return (
                      <button
                        key={m.value}
                        type="button"
                        onClick={() => setMode(m.value)}
                        aria-pressed={on}
                        className={SEGMENT}
                        style={{
                          borderColor: on ? m.accent : BORDER,
                          background: on ? PANEL : "transparent",
                          color: on ? m.accent : CREAM,
                        }}
                      >
                        <Icon size={12} color={on ? m.accent : MUTED} aria-hidden />
                        {m.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <SectionLabel>Difficulty</SectionLabel>
                <div className="flex flex-wrap gap-1.5 @min-[860px]:flex-nowrap @min-[1040px]:gap-2">
                  {DIFFICULTIES.map((d) => {
                    const on = difficulty === d.value;
                    return (
                      <button
                        key={d.value}
                        type="button"
                        onClick={() => setDifficulty(d.value)}
                        aria-pressed={on}
                        className={SEGMENT}
                        style={{ borderColor: on ? d.accent : BORDER, color: on ? d.accent : MUTED }}
                      >
                        <span className="h-1.5 w-1.5 shrink-0" style={{ background: d.accent }} aria-hidden />
                        {d.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <SectionLabel>Questions</SectionLabel>
                <div className="flex flex-wrap gap-1.5 @min-[860px]:flex-nowrap @min-[1040px]:gap-2">
                  {PRACTICE_FORMATS.map((f) => {
                    const on = format === f;
                    return (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setFormat(f)}
                        aria-pressed={on}
                        className={SEGMENT}
                        style={
                          on
                            ? { borderColor: CREAM, background: CREAM, color: BG }
                            : { borderColor: BORDER, color: MUTED }
                        }
                      >
                        {FORMAT_LABELS[f]}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Always shown. Required for a technical or mixed round;
                  optional for a behavioral one, where a sector adds its own
                  questions ("why credit over equity?") to the universal ones. */}
                <div>
                  <SectionLabel>{needsSector ? "Industry" : "Industry (optional)"}</SectionLabel>
                  <PixelMenu
                    label={industryText}
                    open={openMenu === "industry"}
                    onToggle={() => setOpenMenu((m) => (m === "industry" ? null : "industry"))}
                    onClose={closeMenu}
                  >
                    {/* Back to nothing chosen - the page's starting state. */}
                    <button
                      type="button"
                      onClick={() => {
                        setCategories([]);
                        setSpecialties({});
                      }}
                      disabled={categories.length === 0}
                      className="flex w-full items-center gap-2.5 border-b px-3.5 py-2.5 text-left text-xs disabled:opacity-50"
                      style={{ borderColor: BORDER, color: MUTED }}
                    >
                      <PixelBox on={categories.length === 0} />
                      None · clear selection
                    </button>
                    {QUIZ_CATEGORIES.map((c) => {
                      const on = categories.includes(c);
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => toggleCategory(c)}
                          aria-pressed={on}
                          className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-xs"
                          style={{ color: on ? CREAM : MUTED }}
                        >
                          <PixelBox on={on} />
                          {CATEGORY_LABELS[c]}
                        </button>
                      );
                    })}
                  </PixelMenu>
                </div>

              {/* Start closes the left column on the Sector row, so it lines
                  up with the Sector box beside it and the panel ends there.
                  The round's length takes the place of a label, level with
                  Sector's. Last when the columns stack: Start comes after
                  every choice it acts on. */}
              <div className="order-last @min-[860px]:order-none">
                <p className="mb-1.5 text-[11px]" style={{ color: MUTED }}>
                  {missingSector ? (
                    "Pick an industry to start"
                  ) : (
                    <>
                      {ROUND_LENGTH} questions · 100 points · or press <Key>↵</Key>
                    </>
                  )}
                </p>
                <button
                  type="button"
                  onClick={startRound}
                  disabled={isPending || missingSector}
                  title={missingSector ? "Pick an industry first" : undefined}
                  className={`${BTN} min-h-10 w-full justify-center rounded-md border-accent-500 bg-accent-500 px-6 py-2 text-sm text-[#ffffff] shadow-card hover:bg-accent-400`}
                >
                  <Play size={14} />
                  {isPending ? "Starting..." : "Start round"}
                </button>
              </div>

                  {/* The sector, in its own box under the industry. Two
                      industries picked, it asks for a sector in each: one
                      heading per industry, each with its own list. */}
                  <div>
                    <SectionLabel>{categories.length > 1 ? "Sectors (one list per industry)" : "Sector"}</SectionLabel>
                    <PixelMenu
                      label={sectorText}
                      disabled={categories.length === 0}
                      open={openMenu === "sector"}
                      onToggle={() => setOpenMenu((m) => (m === "sector" ? null : "sector"))}
                      onClose={closeMenu}
                    >
                      {categories.map((c, i) => {
                        const picked = specialties[c] ?? [];
                        return (
                          <div key={c} data-sector={c} className={i > 0 ? "border-t" : ""} style={{ borderColor: BORDER }}>
                            <p className="px-3.5 pt-2.5 pb-1 text-xs font-bold" style={{ color: CREAM }}>
                              {CATEGORY_LABELS[c]}
                            </p>
                            <button
                              type="button"
                              onClick={() => setSpecialties((prev) => ({ ...prev, [c]: [] }))}
                              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-xs"
                              style={{ color: picked.length === 0 ? CREAM : MUTED }}
                            >
                              <PixelBox on={picked.length === 0} />
                              All {CATEGORY_LABELS[c]}
                            </button>
                            {QUIZ_SPECIALTIES[c].map((sp) => {
                              const spOn = picked.includes(sp);
                              return (
                                <button
                                  key={sp}
                                  type="button"
                                  onClick={() => toggleSpecialty(c, sp)}
                                  className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-xs"
                                  style={{ color: spOn ? CREAM : MUTED }}
                                >
                                  <PixelBox on={spOn} />
                                  {sp}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })}
                    </PixelMenu>
                  </div>
            </div>
          </div>
        )}

        {/* ───────── in-round HUD ───────── */}
        {(phase === "answering" || phase === "graded") && (
          <div className="mb-5">
            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                {Array.from({ length: ROUND_LENGTH }).map((_, i) => {
                  const done = i < results.length;
                  const current = i === results.length && phase === "answering";
                  return (
                    <span
                      key={i}
                      className="h-2.5 w-2.5 border"
                      style={{
                        borderColor: done ? (results[i] ? CYAN : RED) : current ? CREAM : BORDER,
                        background: done ? (results[i] ? CYAN : RED) : current ? CREAM : "transparent",
                      }}
                    />
                  );
                })}
              </div>

              <div className="flex items-center gap-4">
                {tier && (
                  <span className="flex items-center gap-1.5 text-xs font-bold" style={{ color: tier.color }}>
                    <Flame size={13} className="animate-flame" />
                    {roundStreak}
                    <span className="text-xs tracking-wide">{tier.label}</span>
                  </span>
                )}
                <span className="text-sm font-bold" style={{ color: CREAM }}>
                  {score}
                  <span className="text-xs font-normal" style={{ color: MUTED }}>
                    /100
                  </span>
                </span>
              </div>
            </div>
            <p className="text-xs font-medium uppercase tracking-wide" style={{ color: MUTED }}>
              Question {questionNumber} of {ROUND_LENGTH}
            </p>
          </div>
        )}

        {isPending && !grade && phase !== "setup" && (
          <div className="flex items-center justify-center gap-2 py-12 text-xs" style={{ color: MUTED }}>
            <Sparkles size={14} className="animate-flame" color={GOLD} />
            Working...
          </div>
        )}

        {/* ───────── question ───────── */}
        {question && (phase === "answering" || phase === "graded") && !isPending && (
          <div key={question.prompt} className="space-y-4">
            <div>
              <div className="mb-2.5 flex flex-wrap items-center gap-2">
                <Tag color={activeMode.accent}>{question.topic}</Tag>
                <Tag color={MUTED}>{DIFFICULTY_LABELS[question.difficulty]}</Tag>
                <Tag color={question.kind === "behavioral" ? ROSE : CYAN}>{question.kind}</Tag>
              </div>
              <p className="text-base leading-relaxed" style={{ color: CREAM }}>
                {question.prompt}
              </p>
            </div>

            {phase === "answering" && (
              <>
                {question.options ? (
                  // Multiple choice: selecting an option IS the answer, so the
                  // option text goes straight into `answer` and the existing
                  // submit path marks it - deterministically, with no API call.
                  <div className="flex flex-col gap-2">
                    {question.options.map((opt) => {
                      const on = answer === opt;
                      return (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => setAnswer(opt)}
                          className="border px-4 py-3 text-left text-xs leading-relaxed"
                          style={{
                            borderColor: on ? CREAM : BORDER,
                            background: on ? SELECTED_BG : "transparent",
                            color: on ? CREAM : MUTED,
                          }}
                        >
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <textarea
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    rows={7}
                    autoFocus
                    placeholder="Answer as you would out loud in an interview - walk through your reasoning, not just the conclusion."
                    className="w-full border bg-transparent px-3.5 py-3 text-sm leading-relaxed focus:outline-none"
                    style={{ borderColor: BORDER, color: CREAM }}
                  />
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={isPending || !answer.trim()}
                    className={`${BTN} px-5 py-2.5 text-sm hover:bg-[var(--learn-fg)] hover:text-[var(--learn-bg)]`}
                    style={{ borderColor: CREAM, color: CREAM }}
                  >
                    <Zap size={13} />
                    Submit
                  </button>
                  <span className="text-xs" style={{ color: MUTED }}>
                    or press <Key>↵</Key> · <Key>Shift</Key> <Key>↵</Key> for a new line
                  </span>
                </div>
              </>
            )}

            {phase === "graded" && grade && (
              <div
                className="relative space-y-3.5 border p-4"
                style={{
                  borderColor: grade.passed ? CYAN : RED,
                  background: grade.passed ? PASS_BG : FAIL_BG,
                }}
              >
                {/* floating points */}
                <span
                  className="pointer-events-none absolute right-4 top-3 animate-score-pop text-xl font-black"
                  style={{ color: grade.passed ? CYAN : RED }}
                >
                  +{grade.points}
                </span>

                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold" style={{ color: CREAM }}>
                      {grade.verdict}
                    </p>
                    <p className="mt-1 text-xs uppercase tracking-wide" style={{ color: MUTED }}>
                      Marked {GRADING_LEVEL_LABELS[grade.level].toLowerCase()} ·{" "}
                      {DIFFICULTY_LABELS[question.difficulty]}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-2xl font-black leading-none" style={{ color: grade.passed ? CYAN : RED }}>
                      {grade.score}
                      <span className="text-sm font-medium" style={{ color: MUTED }}>
                        /10
                      </span>
                    </p>
                  </div>
                </div>

                {grade.passed && roundStreak >= 3 && (
                  <p className="flex items-center gap-1.5 text-xs font-bold" style={{ color: GOLD }}>
                    <Flame size={12} className="animate-flame" />
                    {roundStreak} in a row!
                  </p>
                )}

                <p className="text-sm leading-relaxed" style={{ color: CREAM }}>
                  {grade.feedback}
                </p>

                {grade.errors.length > 0 && (
                  <div className="border p-2.5" style={{ borderColor: RED, background: FAIL_BG }}>
                    <p className="mb-1 text-xs font-bold uppercase tracking-wide" style={{ color: RED }}>
                      Got wrong
                    </p>
                    <ul className="space-y-1">
                      {grade.errors.map((e, i) => (
                        <li key={i} className="text-xs" style={{ color: RED }}>
                          &#215; {e}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {grade.missed.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-bold uppercase tracking-wide" style={{ color: MUTED }}>
                      You missed
                    </p>
                    <ul className="space-y-1">
                      {grade.missed.map((p, i) => (
                        <li key={i} className="text-xs" style={{ color: MUTED }}>
                          &#8722; {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-3 pt-0.5">
                  <button
                    type="button"
                    onClick={handleNext}
                    disabled={isPending}
                    className={`${BTN} px-5 py-2.5 text-sm hover:bg-[var(--learn-fg)] hover:text-[var(--learn-bg)]`}
                    style={{ borderColor: CREAM, color: CREAM }}
                  >
                    {questionNumber >= ROUND_LENGTH ? "See results" : "Next question"}
                    <ChevronRight size={14} />
                  </button>
                  <span className="text-xs" style={{ color: MUTED }}>
                    or press <Key>↵</Key>
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ───────── summary ───────── */}
        {phase === "summary" && summary && (
          <div className="relative py-4 text-center">
            {summary.isPersonalBest && <Confetti />}

            {summary.isPersonalBest && (
              <p
                className="mb-3 inline-flex items-center gap-1.5 border px-3.5 py-1.5 text-xs font-black uppercase tracking-wide"
                style={{ borderColor: GOLD, color: GOLD }}
              >
                <Trophy size={12} />
                New personal best
              </p>
            )}

            <p className="text-5xl font-black leading-none" style={{ color: CREAM }}>
              {summary.score}
              <span className="text-xl font-medium" style={{ color: MUTED }}>
                /100
              </span>
            </p>
            <p className="mt-2 text-sm font-bold" style={{ color: band(summary.score).tone }}>
              {band(summary.score).label}
            </p>

            <div
              className="mx-auto mt-5 flex max-w-md flex-wrap items-center justify-center gap-x-6 gap-y-2 border-y py-3 text-xs"
              style={{ borderColor: BORDER, color: MUTED }}
            >
              <span>
                Best streak <span className="font-bold" style={{ color: GOLD }}>{summary.bestStreak}</span>
              </span>
              <span>
                Personal best <span className="font-bold" style={{ color: CREAM }}>{summary.personalBest}/100</span>
              </span>
              {roundsThisSitting > 1 && (
                <span>
                  This sitting{" "}
                  <span className="font-bold" style={{ color: CREAM }}>
                    {roundsThisSitting} rounds · {sittingPoints} pts
                  </span>
                </span>
              )}
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={startRound}
                disabled={isPending}
                className={`${BTN} px-6 py-3 text-sm hover:bg-[var(--learn-fg)] hover:text-[var(--learn-bg)]`}
                style={{ borderColor: CREAM, color: CREAM }}
              >
                <RotateCcw size={14} />
                {isPending ? "Starting..." : "Next round"}
              </button>
              <button
                type="button"
                onClick={() => setPhase("setup")}
                className={`${BTN} px-5 py-3 text-sm`}
                style={{ borderColor: BORDER, color: MUTED }}
              >
                Change setup
              </button>
            </div>
            <p className="mt-3 text-xs" style={{ color: MUTED }}>
              Press <Key>↵</Key> to keep going
            </p>
          </div>
        )}

        {error && (
          <p className="mt-3 text-xs" style={{ color: RED }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: MUTED }}>
      {children}
    </p>
  );
}

function Tag({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span
      className="rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize"
      style={{ borderColor: color, color }}
    >
      {children}
    </span>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className="rounded border px-1.5 py-0.5 font-sans text-[11px] font-medium"
      style={{ borderColor: BORDER, background: PANEL, color: CREAM }}
    >
      {children}
    </kbd>
  );
}

function Stat({
  icon,
  label,
  value,
  suffix,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  suffix?: string;
  tone: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span style={{ color: tone }}>{icon}</span>
      <span className="text-xs" style={{ color: MUTED }}>
        {label}
      </span>
      <span className="text-sm font-semibold" style={{ color: CREAM }}>
        {value}
        {suffix && (
          <span className="text-xs font-medium" style={{ color: MUTED }}>
            {suffix}
          </span>
        )}
      </span>
    </span>
  );
}

// Purely decorative burst for a new personal best. Fixed offsets rather than
// random so it renders identically on server and client - a random layout here
// would hydrate mismatched.
const CONFETTI = [
  { left: "10%", color: CREAM, delay: "0ms" },
  { left: "25%", color: GOLD, delay: "120ms" },
  { left: "40%", color: CYAN, delay: "60ms" },
  { left: "55%", color: ROSE, delay: "180ms" },
  { left: "70%", color: CYAN, delay: "40ms" },
  { left: "85%", color: GOLD, delay: "150ms" },
];

function Confetti() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 h-0" aria-hidden>
      {CONFETTI.map((c, i) => (
        <span
          key={i}
          className="absolute top-0 h-2 w-2 animate-confetti"
          style={{ left: c.left, background: c.color, animationDelay: c.delay }}
        />
      ))}
    </div>
  );
}

/** The square tick box the industry dropdown uses, filled when on. */
function PixelBox({ on }: { on: boolean }) {
  return (
    <span
      className="block h-2.5 w-2.5 shrink-0 border"
      style={{ borderColor: on ? CREAM : MUTED, background: on ? CREAM : "transparent" }}
    />
  );
}
