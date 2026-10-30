"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RotateCcw, Volume2, VolumeX } from "lucide-react";

import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";

/**
 * The interviewer: a friendly robot that asks each question out loud with the
 * browser's own text-to-speech, and shows it as text at the same time - the
 * text is the real interface, the voice is a convenience. Nothing is sent
 * anywhere to speak; speechSynthesis runs on the device.
 */

const MUTE_KEY = "offerly.videoCoach.muted";

// The mute choice, as a tiny external store: read during render through
// useSyncExternalStore, so there is no setState-in-effect to hydrate it, and
// the server renders "not muted" (it cannot know).
const muteListeners = new Set<() => void>();
function readMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return memoryMuted;
  }
}
let memoryMuted = false;
function writeMuted(on: boolean) {
  memoryMuted = on;
  try {
    window.localStorage.setItem(MUTE_KEY, on ? "1" : "0");
  } catch {
    // Private mode: the choice lasts for this visit only.
  }
  muteListeners.forEach((l) => l());
}
function subscribeMuted(l: () => void) {
  muteListeners.add(l);
  return () => muteListeners.delete(l);
}
const noSubscribe = () => () => {};
const ttsSupported = () => "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

/** A clear English voice when the device has one, else the default. */
function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  const en = voices.filter((v) => v.lang?.toLowerCase().startsWith("en"));
  const preferred = ["Samantha", "Google US English", "Microsoft Aria", "Microsoft Jenny", "Karen", "Daniel"];
  for (const name of preferred) {
    const v = en.find((x) => x.name.includes(name));
    if (v) return v;
  }
  return en.find((v) => v.localService) ?? en[0] ?? null;
}

/**
 * Speaks a line and reports when it is done. `onDone` fires exactly once per
 * `speak` - on the utterance's end, on an error, on mute, or after a timeout
 * scaled to the text, because some browsers never fire `end` at all.
 */
export function useInterviewerVoice() {
  const muted = useSyncExternalStore(subscribeMuted, readMuted, () => false);
  const available = useSyncExternalStore(noSubscribe, ttsSupported, () => false);
  const [speaking, setSpeaking] = useState(false);
  const doneRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const settle = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setSpeaking(false);
    const done = doneRef.current;
    doneRef.current = null;
    done?.();
  }, []);

  const speak = useCallback(
    (text: string, onDone?: () => void) => {
      window.speechSynthesis?.cancel();
      doneRef.current = onDone ?? null;
      if (muted || !available) {
        settle();
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      const voice = pickVoice();
      if (voice) u.voice = voice;
      u.rate = 0.98;
      u.pitch = 1.05;
      u.onend = settle;
      u.onerror = settle;
      setSpeaking(true);
      window.speechSynthesis.speak(u);
      // ~2.6 words a second, plus slack for the voice to load.
      const words = text.split(/\s+/).length;
      timerRef.current = window.setTimeout(settle, Math.min(40_000, (words / 2.6) * 1000 + 4000));
    },
    [available, muted, settle],
  );

  const stop = useCallback(() => {
    window.speechSynthesis?.cancel();
    settle();
  }, [settle]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    writeMuted(next);
    if (next) {
      window.speechSynthesis?.cancel();
      // Muting mid-question ends the speech, so think time starts now.
      settle();
    }
  }, [muted, settle]);

  return { muted, speaking, available, speak, stop, toggleMute };
}

export default function RobotInterviewer({
  prompt,
  label,
  speaking,
  muted,
  voiceAvailable,
  onReplay,
  onToggleMute,
  compact,
}: {
  prompt: string | null;
  label: string;
  speaking: boolean;
  muted: boolean;
  voiceAvailable: boolean;
  onReplay: () => void;
  onToggleMute: () => void;
  compact?: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className={`flex items-start gap-4 ${compact ? "" : "lg:flex-col lg:items-center lg:text-center"}`}>
        <RobotFace speaking={speaking} size={compact ? 64 : 112} />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-warmgray-500">{label}</p>
          {/* The question, as text - always, voice or not. Announced politely
              so a screen reader reads it once, when it changes. */}
          <p aria-live="polite" className={`mt-1 leading-relaxed text-brand-900 ${compact ? "text-base" : "text-lg"}`}>
            {prompt ?? "Hi - I'll be your interviewer. When you're ready, I'll ask you five questions, one at a time."}
          </p>
        </div>
      </div>
      {prompt && (
        <div className={`mt-4 flex flex-wrap gap-2 ${compact ? "" : "lg:justify-center"}`}>
          <button
            type="button"
            onClick={onReplay}
            disabled={!voiceAvailable || muted}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-brand-100 bg-[#ffffff] px-3 text-sm text-brand-900 hover:border-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:opacity-50"
          >
            <RotateCcw size={14} aria-hidden />
            Replay question
          </button>
          <button
            type="button"
            onClick={onToggleMute}
            disabled={!voiceAvailable}
            aria-pressed={muted}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-brand-100 bg-[#ffffff] px-3 text-sm text-brand-900 hover:border-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:opacity-50"
          >
            {muted ? <VolumeX size={14} aria-hidden /> : <Volume2 size={14} aria-hidden />}
            {muted ? "Unmute interviewer" : "Mute interviewer"}
          </button>
          {!voiceAvailable && <span className="self-center text-xs text-warmgray-500">This browser can&apos;t read questions aloud - read them above.</span>}
        </div>
      )}
    </div>
  );
}

/** The robot. Blinks and moves its mouth while speaking - both off under
 *  prefers-reduced-motion. Decorative: the question text carries the meaning. */
function RobotFace({ speaking, size }: { speaking: boolean; size: number }) {
  const reduced = usePrefersReducedMotion();
  const animate = !reduced;
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="robot-head" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#dbe4f2" />
        </linearGradient>
      </defs>
      {/* antenna */}
      <line x1="60" y1="10" x2="60" y2="24" stroke="#33517a" strokeWidth="3" strokeLinecap="round" />
      <circle cx="60" cy="9" r="5" fill={speaking ? "#e0a93b" : "#9fb2cf"}>
        {animate && speaking && <animate attributeName="opacity" values="1;0.4;1" dur="1s" repeatCount="indefinite" />}
      </circle>
      {/* ears */}
      <rect x="10" y="50" width="10" height="24" rx="5" fill="#33517a" />
      <rect x="100" y="50" width="10" height="24" rx="5" fill="#33517a" />
      {/* head */}
      <rect x="18" y="24" width="84" height="76" rx="24" fill="url(#robot-head)" stroke="#33517a" strokeWidth="3" />
      {/* visor */}
      <rect x="28" y="38" width="64" height="34" rx="16" fill="#0b1526" />
      {/* eyes */}
      <g fill="#7fd1e6">
        <ellipse cx="46" cy="55" rx="6" ry="7">
          {animate && <animate attributeName="ry" values="7;7;0.8;7;7" keyTimes="0;0.92;0.95;0.98;1" dur="4.5s" repeatCount="indefinite" />}
        </ellipse>
        <ellipse cx="74" cy="55" rx="6" ry="7">
          {animate && <animate attributeName="ry" values="7;7;0.8;7;7" keyTimes="0;0.92;0.95;0.98;1" dur="4.5s" repeatCount="indefinite" />}
        </ellipse>
      </g>
      {/* cheeks */}
      <circle cx="34" cy="82" r="4" fill="#f4b6a8" opacity="0.8" />
      <circle cx="86" cy="82" r="4" fill="#f4b6a8" opacity="0.8" />
      {/* mouth: a smile at rest, opening and closing while speaking */}
      {speaking ? (
        <rect x="50" y="80" width="20" height="8" rx="4" fill="#33517a">
          {animate && <animate attributeName="height" values="3;9;4;8;3" dur="0.6s" repeatCount="indefinite" />}
        </rect>
      ) : (
        <path d="M49 82 Q60 91 71 82" fill="none" stroke="#33517a" strokeWidth="3" strokeLinecap="round" />
      )}
    </svg>
  );
}
