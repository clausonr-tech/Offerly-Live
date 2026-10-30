"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { pixelFont } from "./pixel-font";
import { Trophy, X } from "lucide-react";
import {
  getPracticeQuestion,
  submitPracticeAnswer,
  completePracticeRound,
  fetchRecentGamePlayers,
  type RecentGamePlay,
} from "./practice-actions";
import type { PracticeQuestion, RoundDifficulty, RoundSummary } from "@/lib/practice-session";
import type { QuizCategory } from "@/lib/question-bank/types";
import { ROUND_LENGTH } from "@/lib/question-bank/types";

// Fixed-pixel vertical spacing rather than percent-of-container: a camera
// that follows the climb (see cameraOffset below) needs to know exactly how
// far one platform is from the next in real pixels, not a fraction of a
// container height that changes with viewport size. Horizontal placement
// stays a simple left/right stagger so the climb reads as a path rather than
// a straight ladder.
const PLATFORM_GAP = 96;
const PLATFORM_LEFT: number[] = [50, 18, 78, 28, 72, 20, 76, 26, 70, 22, 50];
function platformBottom(i: number) {
  return i * PLATFORM_GAP;
}

// How many platforms of "lead" the camera gives the player before it starts
// panning - the scene holds still near the ground rather than creeping
// upward on the very first jump, then follows from here on, always keeping
// the current platform (and the one or two above it) in the fixed-height
// viewport below. This - not the old one-screen-shows-everything layout - is
// what makes the "zoomed in, only a couple of blocks visible" framing work.
const CAMERA_LAG = 1;

// The player sprite: a 10-wide x 18-tall pixel grid (one character per cell,
// "." for transparent), rendered as SVG rects rather than ~150 hand-written
// <rect> elements. Real colour against the scene, not another shade of the
// same background, is what actually reads as "a little businessman" instead
// of a formless blob - and the taller grid (up from 8x11) is what gives him
// hands, a jacket hem and distinct shoes instead of a blockier outline.
const SPRITE_ROWS = [
  "..HHHHHH..",
  ".HHHHHHHH.",
  "HHHHHHHHHH",
  "HHFFFFFFHH",
  ".FFEFFEFF.",
  ".FFFFFFFF.",
  ".FFFFFFFF.",
  "..FFFFFF..",
  ".JJWWWWJJ.",
  ".JJWWTWJJ.",
  ".JJWWTWJJ.",
  ".JJWWTWJJ.",
  ".FJWWTWJF.",
  ".JJJJJJJJ.",
  "..PP..PP..",
  "..PP..PP..",
  "..BB..BB..",
  ".BBB.BBB..",
] as const;

const SPRITE_COLORS: Record<string, string> = {
  H: "#14110d", // slicked-back black hair
  F: "#e0b088", // face and hands
  E: "#0b0f0d", // eyes
  W: "#f4f4f0", // shirt collar
  J: "#1c2740", // suit jacket
  T: "#7a1f1f", // tie
  P: "#141c2c", // trousers
  B: "#0b0f0d", // shoes
};

function PixelBusinessman({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 10 18" shapeRendering="crispEdges" className={className} aria-hidden>
      {SPRITE_ROWS.flatMap((row, y) =>
        [...row].map((cell, x) =>
          cell === "." ? null : (
            <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={SPRITE_COLORS[cell]} />
          ),
        ),
      )}
    </svg>
  );
}

// A single flat-colour puffy pixel cloud, drawn the same "string grid of
// rects" way as the sprite above.
const CLOUD_ROWS = ["...XXXX.....", "..XXXXXXXX..", "XXXXXXXXXXXX", "XXXXXXXXXXXX", ".XXXXXXXXXX."] as const;

function PixelCloud({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 12 5" shapeRendering="crispEdges" className={className} style={style} aria-hidden>
      {CLOUD_ROWS.flatMap((row, y) =>
        [...row].map((cell, x) => (cell === "." ? null : <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#f2f8ff" />)),
      )}
    </svg>
  );
}

// The flagpole assembly at the top platform: a bare pole plus a pennant that
// starts folded at its base and climbs to the top on a perfect run (see
// flagReached below). Sized well past the old single lucide icon so it reads
// as a real landmark in the zoomed-in scene rather than a small badge.
const FLAGPOLE_HEIGHT = 48;
const FLAG_W = 20;
const FLAG_H = 14;
const FLAG_ROWS = [
  "XXXXXXXXXX",
  "XXXXXXXXXX",
  "XXXXXXXXX.",
  "XXXXXXX...",
  "XXXXX.....",
  "XXXXXXX...",
  "XXXXXXXXX.",
] as const;

function PixelFlag({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 10 7" shapeRendering="crispEdges" className={className} style={style} aria-hidden>
      {FLAG_ROWS.flatMap((row, y) =>
        [...row].map((cell, x) => (cell === "." ? null : <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" />)),
      )}
    </svg>
  );
}

// Hand-tuned rather than randomised: a random layout would hydrate mismatched
// between server and client. Negative animationDelay starts each cloud
// already partway through its own loop, so they don't all bunch up together
// on first paint.
const CLOUDS: { top: number; width: number; dir: "lr" | "rl"; duration: number; delay: number }[] = [
  { top: 8, width: 72, dir: "lr", duration: 52, delay: -8 },
  { top: 24, width: 50, dir: "rl", duration: 68, delay: -30 },
  { top: 42, width: 84, dir: "lr", duration: 80, delay: -46 },
  { top: 60, width: 58, dir: "rl", duration: 60, delay: -4 },
];

type GamePhase = "loading" | "question" | "revealed" | "finished" | "error";

export default function PlatformerGame({
  categories,
  specialties,
  difficulty,
  initialCurrentStreak,
  initialBestStreak,
  onExit,
  onStreakUpdate,
  onRoundComplete,
}: {
  categories: QuizCategory[];
  /** Per sector, the specialties it is narrowed to - see PracticeSession. */
  specialties: Partial<Record<QuizCategory, string[]>>;
  difficulty: RoundDifficulty;
  /** The account's real streak going in - a streak is "consecutive correct
   *  answers with no miss yet," which by definition can span rounds, so a
   *  round starting doesn't get to reset it back to zero. */
  initialCurrentStreak: number;
  initialBestStreak: number;
  onExit: () => void;
  onStreakUpdate: (currentStreak: number, bestStreak: number) => void;
  onRoundComplete: (summary: RoundSummary) => void;
}) {
  const roundConfig = useMemo(
    () => ({ mode: "technical", difficulty, categories, specialties, format: "multiple_choice" }),
    [difficulty, categories, specialties],
  );

  const [phase, setPhase] = useState<GamePhase>("loading");
  const [questionIndex, setQuestionIndex] = useState(0); // 0-based, 0..ROUND_LENGTH-1
  const [question, setQuestion] = useState<PracticeQuestion | null>(null);
  const [seenPrompts, setSeenPrompts] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [wasCorrect, setWasCorrect] = useState(false);
  const [score, setScore] = useState(0);
  const [correctCount, setCorrectCount] = useState(0); // doubles as the platform index
  // The right option arrives with the grade, never with the question - the
  // answer key stays encrypted until the player has committed (practice-seal).
  const [revealedAnswer, setRevealedAnswer] = useState<string | null>(null);
  // Signed receipts of each graded answer; the round is saved from these.
  const [receipts, setReceipts] = useState<string[]>([]);
  // Mirrors the server's authoritative streak, not a locally-recomputed one -
  // never reset by playAgain(), since starting a new round doesn't break a
  // real streak. This is also why it can display higher than ROUND_LENGTH:
  // it's the count across every round played without a miss, not this
  // round's own tally.
  const [liveStreak, setLiveStreak] = useState(initialCurrentStreak);
  const [liveBestStreak, setLiveBestStreak] = useState(initialBestStreak);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<RoundSummary | null>(null);
  const [leaderboard, setLeaderboard] = useState<RecentGamePlay[] | null>(null);

  const loadQuestion = useCallback(
    async (seen: string[]) => {
      setPhase("loading");
      setSelected(null);
      setRevealedAnswer(null);
      setQuestion(null);
      // The hand-authored MC pool can run dry for a given category/difficulty
      // combo, in which case generatePracticeQuestion falls back to a written
      // question - unusable in a screen built only for four answer buttons.
      // Loop rather than recurse: a few retries with the prompt marked seen,
      // then give up with a clear message instead of spinning forever.
      let attemptSeen = seen;
      for (let attempt = 0; attempt <= 4; attempt++) {
        const result = await getPracticeQuestion(roundConfig, attemptSeen);
        if (result.error || !result.question) {
          setError(result.error ?? "Couldn't load a question.");
          setPhase("error");
          return;
        }
        if (result.question.format === "multiple_choice" && result.question.options) {
          setQuestion(result.question);
          setPhase("question");
          return;
        }
        attemptSeen = [...attemptSeen, result.question.prompt];
      }
      setError("Not enough multiple-choice questions for this setup - try different industries.");
      setPhase("error");
    },
    [roundConfig],
  );

  useEffect(() => {
    // Deferred a tick so the effect body itself never calls setState
    // synchronously - it only kicks off a microtask that does.
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) loadQuestion([]);
    });
    return () => {
      cancelled = true;
    };
  }, [loadQuestion]);

  // Clicking an option only ever selects it - the player can click between
  // options freely while still on "question". Nothing is graded, and no
  // request goes out, until they commit with Submit.
  function selectOption(option: string) {
    if (phase !== "question") return;
    setSelected(option);
  }

  function submitAnswer() {
    if (phase !== "question" || !question || !selected || isSubmitting) return;
    // Locks the button for the round-trip, not just visually - without this,
    // a fast double-click could fire two grading calls for one answer and
    // double up the score, the platform jump, and the streak together.
    setIsSubmitting(true);
    const option = selected;
    submitPracticeAnswer(question, option).then((result) => {
      setIsSubmitting(false);
      if (!result.grade) return;
      const g = result.grade;
      setWasCorrect(g.passed);
      setRevealedAnswer(g.correctOption ?? null);
      setReceipts((r) => [...r, g.receipt]);
      setScore((s) => s + g.points);
      if (g.passed) setCorrectCount((c) => c + 1);
      // The grader already computed both correctly (a wrong answer breaks
      // the streak outright; the best is a high-water mark a later miss never
      // erases) - mirror its numbers rather than re-deriving them from local
      // state, which is what let a round boundary quietly reset a real streak
      // back to zero before.
      setLiveStreak(g.currentStreak);
      setLiveBestStreak(g.bestStreak);
      onStreakUpdate(g.currentStreak, g.bestStreak);
      setSeenPrompts((s) => [...s, question.prompt]);
      setPhase("revealed");
    });
  }

  function next() {
    if (questionIndex + 1 >= ROUND_LENGTH) {
      completePracticeRound(roundConfig, receipts).then((result) => {
        if (result.summary) {
          setSummary(result.summary);
          onRoundComplete(result.summary);
        }
      });
      fetchRecentGamePlayers().then((r) => setLeaderboard(r.players));
      setPhase("finished");
      return;
    }
    setQuestionIndex((n) => n + 1);
    loadQuestion(seenPrompts);
  }

  function playAgain() {
    setQuestionIndex(0);
    setScore(0);
    setCorrectCount(0);
    setReceipts([]);
    // liveStreak/liveBestStreak are deliberately left alone here - a new
    // round starting is not a miss, so a real streak carries into it.
    setSeenPrompts([]);
    setSummary(null);
    setLeaderboard(null);
    loadQuestion([]);
  }

  const platformIndex = Math.min(correctCount, ROUND_LENGTH);
  const flagReached = correctCount >= ROUND_LENGTH;
  // Track height needs every platform plus headroom above the flag; the
  // camera then pans this whole track vertically inside a short, fixed-height
  // viewport instead of laying all eleven platforms out across the screen at
  // once - which is what actually makes it read as "zoomed in."
  const trackHeight = ROUND_LENGTH * PLATFORM_GAP + 220;
  const cameraOffset = Math.max(0, platformIndex - CAMERA_LAG) * PLATFORM_GAP;

  // Portalled straight to the themed root, not rendered in place: the app
  // wraps every page in an `.app-reveal` mount-animation wrapper that carries
  // a (post-animation, identity) CSS transform, and per spec a transformed
  // ancestor becomes the containing block for any `position: fixed`
  // descendant - without the portal this "full-screen" game would actually
  // be boxed into that wrapper's content area instead of the viewport.
  return createPortal(
    <div className={`${pixelFont.className} fixed inset-0 z-[100] flex flex-col overflow-hidden bg-[#0b0f0d] text-[#9bbc0f]`}>
      <div className="flex items-center justify-between border-b-4 border-[#3a4a2f] px-4 py-3 text-[9px] sm:text-[11px]">
        <button
          type="button"
          onClick={onExit}
          className="flex items-center gap-1.5 text-[#e0483e] hover:opacity-75"
        >
          <X size={13} /> QUIT
        </button>
        <span>
          Q {Math.min(questionIndex + 1, ROUND_LENGTH)}/{ROUND_LENGTH}
        </span>
        <span className="flex items-center gap-3">
          <span className={liveStreak > 0 ? "text-[#e0ad4a]" : ""}>STREAK {liveStreak}</span>
          <span>SCORE {score}</span>
        </span>
      </div>

      {/* ───────── platform scene ───────── */}
      {/* A short, fixed-height, clipped viewport - not the old "every
          platform laid out across the whole screen" - is the "zoomed in"
          framing. Sky and clouds live directly in this viewport, unaffected
          by the climb; only the `track` below (platforms, flag, sprite) pans
          vertically inside it. */}
      <div
        className="relative h-[260px] shrink-0 overflow-hidden sm:h-[300px]"
        style={{
          background:
            "linear-gradient(to bottom, #3f7fc9 0%, #3f7fc9 38%, #6fb3e0 38%, #6fb3e0 68%, #a3d6ec 68%, #a3d6ec 100%)",
        }}
      >
        {CLOUDS.map((c, i) => (
          <PixelCloud
            key={i}
            className={`absolute ${c.dir === "lr" ? "animate-cloud-drift-lr" : "animate-cloud-drift-rl"}`}
            style={{
              top: `${c.top}%`,
              width: `${c.width}px`,
              height: `${(c.width * 5) / 12}px`,
              animationDuration: `${c.duration}s`,
              animationDelay: `${c.delay}s`,
            }}
          />
        ))}

        <div
          className="absolute inset-x-0 bottom-0 transition-transform duration-500 ease-out"
          style={{ height: trackHeight, transform: `translateY(${cameraOffset}px)` }}
        >
          {Array.from({ length: ROUND_LENGTH + 1 }).map((_, i) => (
            <div
              key={i}
              className="absolute h-3 w-16 -translate-x-1/2 border-2 border-[#8a6423] bg-[#e0ad4a] sm:w-20"
              style={{ left: `${PLATFORM_LEFT[i]}%`, bottom: platformBottom(i) }}
            />
          ))}

          {/* Platform blocks are 12px tall (h-3) regardless of breakpoint, so
              that fixed 12px - not another percentage guess - is what actually
              plants a sprite's feet on the surface rather than floating above
              or sinking into it. No Y-transform needed: `bottom` already
              anchors the element's own bottom edge there. */}
          <div
            className="absolute -translate-x-1/2 bg-[#4a4a42]"
            style={{
              left: `${PLATFORM_LEFT[ROUND_LENGTH]}%`,
              bottom: platformBottom(ROUND_LENGTH) + 12,
              width: 3,
              height: FLAGPOLE_HEIGHT,
            }}
          />
          {/* The flag itself starts folded at the pole's base and climbs to
              the top on a perfect run - color only turns green once the
              climb finishes (the delay on the color transition, not the
              position one), so reaching the flag reads as a real event
              rather than just a colour swap. */}
          <PixelFlag
            className={flagReached ? "absolute text-[#3ecf5c]" : "absolute text-[#e8f0d8]"}
            style={{
              left: `calc(${PLATFORM_LEFT[ROUND_LENGTH]}% + 3px)`,
              bottom: platformBottom(ROUND_LENGTH) + 12 + (flagReached ? FLAGPOLE_HEIGHT - FLAG_H - 2 : 2),
              width: FLAG_W,
              height: FLAG_H,
              transition: "bottom 1100ms ease-out, color 300ms ease-in 1100ms",
            }}
          />

          <div
            className={`absolute -translate-x-1/2 transition-[left,bottom] duration-500 ease-out ${
              phase === "revealed" && wasCorrect ? "animate-game-jump" : ""
            }`}
            style={{ left: `${PLATFORM_LEFT[platformIndex]}%`, bottom: platformBottom(platformIndex) + 12 }}
          >
            <div className="relative h-14 w-8 sm:h-16 sm:w-9">
              <PixelBusinessman className="h-full w-full" />
              {phase === "revealed" && !wasCorrect && (
                <div className="pointer-events-none absolute inset-0 animate-game-flash bg-[#e0483e] opacity-0" />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ───────── question / answer console ───────── */}
      <div className="flex-1 overflow-y-auto border-t-4 border-[#2d4a68] bg-[#12233d] p-4 text-[#f0e6d2] sm:p-6">
        {phase === "loading" && (
          <p className="py-6 text-center text-[10px] text-[#7a93b3]">LOADING...</p>
        )}

        {phase === "error" && (
          <div className="py-4 text-center">
            <p className="mb-4 text-[10px] leading-relaxed text-[#e0483e]">{error}</p>
            <button
              type="button"
              onClick={onExit}
              className="border-2 border-[#f0e6d2] px-4 py-2 text-[10px] hover:bg-[#f0e6d2] hover:text-[#12233d]"
            >
              BACK TO SETUP
            </button>
          </div>
        )}

        {question && question.options && (phase === "question" || phase === "revealed") && (
          <div>
            <p className="mb-4 text-[10px] leading-relaxed sm:text-[12px]">{question.prompt}</p>
            <div className="flex flex-col gap-2">
              {question.options.map((opt) => {
                const isSelected = selected === opt;
                const isAnswer = opt === revealedAnswer;
                const revealed = phase === "revealed";
                const stateClass = revealed
                  ? isAnswer
                    ? "border-[#5cc4d6] bg-[#122430] text-[#5cc4d6]"
                    : isSelected
                      ? "border-[#e0483e] bg-[#2a1414] text-[#e0483e]"
                      : "border-[#2d4a68] text-[#7a93b3]"
                  : isSelected
                    ? "border-[#f0e6d2] bg-[#1a2e4a] text-[#f0e6d2]"
                    : "border-[#2d4a68] hover:border-[#f0e6d2]";
                return (
                  <button
                    key={opt}
                    type="button"
                    disabled={phase !== "question" || isSubmitting}
                    onClick={() => selectOption(opt)}
                    className={`border-2 px-3 py-2.5 text-left text-[9px] leading-relaxed sm:text-[10px] ${stateClass}`}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>

            {phase === "question" && (
              <div className="mt-4 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={submitAnswer}
                  disabled={!selected || isSubmitting}
                  className="border-2 border-[#f0e6d2] px-4 py-2 text-[10px] hover:bg-[#f0e6d2] hover:text-[#12233d] disabled:cursor-not-allowed disabled:border-[#2d4a68] disabled:text-[#7a93b3] disabled:hover:bg-transparent disabled:hover:text-[#7a93b3]"
                >
                  {isSubmitting ? "..." : "SUBMIT"}
                </button>
              </div>
            )}

            {phase === "revealed" && (
              <div className="mt-4 flex items-center justify-between gap-3">
                <span className={`text-[10px] ${wasCorrect ? "text-[#5cc4d6]" : "text-[#e0483e]"}`}>
                  {wasCorrect ? "CORRECT +10" : "WRONG"}
                </span>
                <button
                  type="button"
                  onClick={next}
                  className="border-2 border-[#f0e6d2] px-4 py-2 text-[10px] hover:bg-[#f0e6d2] hover:text-[#12233d]"
                >
                  {questionIndex + 1 >= ROUND_LENGTH ? "FINISH" : "NEXT ▶"}
                </button>
              </div>
            )}
          </div>
        )}

        {phase === "finished" && (
          <div className="mx-auto max-w-md py-2 text-center">
            <p className="text-[11px] text-[#f0e6d2]">
              {flagReached ? "★ PERFECT RUN ★" : "GAME OVER"}
            </p>
            <p className="my-4 text-4xl text-[#f0e6d2]">
              {summary ? summary.score : score}
              <span className="text-sm text-[#7a93b3]">/100</span>
            </p>
            {summary?.isPersonalBest && (
              <p className="mb-4 flex items-center justify-center gap-1.5 text-[9px] text-[#e8c94a]">
                <Trophy size={12} /> NEW BEST
              </p>
            )}
            <p className="mb-6 text-[9px] text-[#7a93b3]">BEST STREAK {liveBestStreak}</p>

            {leaderboard && leaderboard.length > 0 && (
              <div className="mb-6 border-2 border-[#2d4a68] p-3 text-left">
                <p className="mb-2 text-[8px] text-[#7a93b3]">RECENTLY PLAYED</p>
                <ul className="space-y-1.5">
                  {leaderboard.map((row, i) => (
                    <li
                      key={`${row.userId}-${i}`}
                      className={`flex items-center justify-between gap-2 text-[8px] ${
                        row.isCurrentUser ? "text-[#f0e6d2]" : "text-[#7a93b3]"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {row.isCurrentUser ? "YOU" : row.displayName.toUpperCase()}
                      </span>
                      <span className="shrink-0">
                        {row.score}/{row.maxScore}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={playAgain}
                className="border-2 border-[#f0e6d2] px-4 py-2 text-[10px] hover:bg-[#f0e6d2] hover:text-[#12233d]"
              >
                PLAY AGAIN
              </button>
              <button
                type="button"
                onClick={onExit}
                className="border-2 border-[#7a93b3] px-4 py-2 text-[10px] text-[#7a93b3] hover:border-[#f0e6d2] hover:text-[#f0e6d2]"
              >
                EXIT
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.querySelector<HTMLElement>("[data-app-theme]") ?? document.body,
  );
}
