import { COUNTDOWN_SECONDS } from "./types";

/**
 * One question's life on screen, as a pure reducer - the page's timers and
 * recorder only react to it, so every transition (think time, the 3-2-1, the
 * automatic start and stop, processing, retry) is testable without a browser.
 *
 *   asking ──speech done──▶ thinking ──(last 3s: countdown)──▶ recording
 *      └─(muted/no TTS: same)      └─"I'm ready": jump to 3-2-1     │
 *                                                                   │ Finish answer, or the limit
 *   next question ◀─processed── processing ◀──recorded── stopping ◀─┘
 *                                   │  ▲
 *                               failed ─retry (same recording, still in memory)
 */

/** "ended": the student chose End interview. Terminal - nothing advances it
 *  (no tick, no countdown, no automatic recording) except a deliberate ASK,
 *  used only to resume if ending the interview fails. */
type MachinePhase = "asking" | "thinking" | "recording" | "stopping" | "processing" | "failed" | "done" | "ended";

export type MachineState = {
  phase: MachinePhase;
  /** Whole seconds of think time left. */
  thinkLeft: number;
  /** Whole seconds recorded so far. */
  recorded: number;
  thinkSeconds: number;
  answerSeconds: number;
  error: string | null;
  retryable: boolean;
};

export type MachineEvent =
  | { type: "ASK"; thinkSeconds: number; answerSeconds: number }
  | { type: "SPEECH_DONE" }
  | { type: "TICK" }
  | { type: "READY_NOW" }
  | { type: "FINISH" }
  | { type: "RECORDER_FAILED"; error: string }
  | { type: "RECORDED" }
  | { type: "PROCESSED" }
  | { type: "PROCESS_FAILED"; error: string; retryable: boolean }
  | { type: "RETRY" }
  | { type: "END" };

/** Finish answer is held back for the first moment of recording, so a
 *  double-tap on "I'm ready" cannot end an answer before it starts. */
export const MIN_RECORD_SECONDS = 2;

export function initialMachine(thinkSeconds: number, answerSeconds: number): MachineState {
  return { phase: "asking", thinkLeft: thinkSeconds, recorded: 0, thinkSeconds, answerSeconds, error: null, retryable: false };
}

/** Whether the big 3-2-1 is showing, and which number. */
export function countdownValue(s: MachineState): number | null {
  return s.phase === "thinking" && s.thinkLeft <= COUNTDOWN_SECONDS && s.thinkLeft > 0 ? s.thinkLeft : null;
}

export function answerLeft(s: MachineState): number {
  return Math.max(0, s.answerSeconds - s.recorded);
}

export function machine(s: MachineState, e: MachineEvent): MachineState {
  // Ended is absorbing: a late tick, a speech callback, a recorder's stop
  // event or a queued "I'm ready" can never restart the question.
  if (s.phase === "ended" && e.type !== "ASK") return s;
  switch (e.type) {
    case "END":
      // Not mid-upload: an answer being processed finishes first (the page
      // hides End interview then). Everything else stops where it is.
      return s.phase === "processing" || s.phase === "stopping" ? s : { ...s, phase: "ended", error: null };
    case "ASK":
      return initialMachine(e.thinkSeconds, e.answerSeconds);
    case "SPEECH_DONE":
      return s.phase === "asking" ? { ...s, phase: "thinking" } : s;
    case "READY_NOW":
      // Skips ahead to the countdown - recording always follows a 3-2-1.
      if (s.phase === "asking") return { ...s, phase: "thinking", thinkLeft: Math.min(s.thinkLeft, COUNTDOWN_SECONDS) };
      if (s.phase === "thinking") return { ...s, thinkLeft: Math.min(s.thinkLeft, COUNTDOWN_SECONDS) };
      return s;
    case "TICK":
      if (s.phase === "thinking") {
        const left = s.thinkLeft - 1;
        // Zero: recording starts on its own.
        return left <= 0 ? { ...s, thinkLeft: 0, phase: "recording", recorded: 0 } : { ...s, thinkLeft: left };
      }
      if (s.phase === "recording") {
        const recorded = s.recorded + 1;
        // The limit: the answer stops on its own.
        return recorded >= s.answerSeconds ? { ...s, recorded: s.answerSeconds, phase: "stopping" } : { ...s, recorded };
      }
      return s;
    case "FINISH":
      return s.phase === "recording" && s.recorded >= MIN_RECORD_SECONDS ? { ...s, phase: "stopping" } : s;
    case "RECORDER_FAILED":
      return s.phase === "recording" || s.phase === "stopping" ? { ...s, phase: "failed", error: e.error, retryable: false } : s;
    case "RECORDED":
      return s.phase === "stopping" ? { ...s, phase: "processing", error: null } : s;
    case "PROCESSED":
      return s.phase === "processing" ? { ...s, phase: "done", error: null } : s;
    case "PROCESS_FAILED":
      return s.phase === "processing" ? { ...s, phase: "failed", error: e.error, retryable: e.retryable } : s;
    case "RETRY":
      return s.phase === "failed" && s.retryable ? { ...s, phase: "processing", error: null } : s;
  }
}
