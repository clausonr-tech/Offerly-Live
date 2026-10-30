"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { Loader2, ShieldCheck, Trash2, Video } from "lucide-react";

import {
  ANALYSIS_CONSENT_POINTS,
  ANSWER_OPTIONS,
  DIFFICULTY_CHOICES,
  DIFFICULTY_CHOICE_LABELS,
  INTERVIEW_MODES,
  MODE_BLURBS,
  MODE_LABELS,
  THINK_OPTIONS,
  type DifficultyChoice,
  type InterviewMode,
  type TrainingChoice,
} from "@/lib/video-interview/types";

export type SetupChoices = { mode: InterviewMode; thinkSeconds: number; answerSeconds: number; difficulty: DifficultyChoice };

export type RecentInterview = { id: string; mode: InterviewMode; overall: number | null; createdAt: string };

export const PRIMARY =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent-500 px-5 py-2.5 text-sm font-semibold text-[#ffffff] shadow-card hover:bg-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:cursor-not-allowed disabled:opacity-60";
export const SECONDARY =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-brand-100 bg-[#ffffff] px-4 py-2.5 text-sm font-medium text-brand-900 hover:border-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:cursor-not-allowed disabled:opacity-60";

export default function InterviewSetup({
  choices,
  onChange,
  onStart,
  starting,
  analysisAccepted,
  onAcceptAnalysis,
  training,
  consentBusy,
  transcriptionReady,
  recent,
  onOpenRecent,
  onDeleteRecent,
  onDeleteAll,
}: {
  choices: SetupChoices;
  onChange: (c: SetupChoices) => void;
  onStart: () => void;
  starting: boolean;
  analysisAccepted: boolean;
  onAcceptAnalysis: () => void;
  /** The standing answer to "contribute my interviews?", or null before the first Start asks. */
  training: TrainingChoice | null;
  consentBusy: boolean;
  transcriptionReady: boolean;
  recent: RecentInterview[];
  onOpenRecent: (id: string) => void;
  onDeleteRecent: (id: string) => void;
  onDeleteAll: () => void;
}) {
  const [agreeTicked, setAgreeTicked] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const agreeId = useId();

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <section className="list-panel border border-brand-100 px-5 py-5 sm:px-6" aria-labelledby="vi-setup-title">
        <h2 id="vi-setup-title" className="text-lg font-semibold text-brand-900">
          Set up your interview
        </h2>
        <p className="mt-1 text-sm text-warmgray-600">
          Five questions, asked by an AI interviewer. Think, then answer on camera against the clock - you get a transcript and feedback on each answer, then a full report.
        </p>

        {!transcriptionReady && (
          <p role="status" className="mt-4 rounded-md border border-gold-200 bg-gold-50 px-3 py-2 text-sm text-brand-900">
            Speech-to-text isn&apos;t set up on this server yet, so answers can&apos;t be transcribed or scored. You can still practise and watch your answers back on this device.
          </p>
        )}

        <fieldset className="mt-5">
          <legend className="text-[11px] font-medium uppercase tracking-wide text-warmgray-500">Interview type</legend>
          <div role="radiogroup" aria-label="Interview type" className="mt-2 grid gap-2 sm:grid-cols-3">
            {INTERVIEW_MODES.map((m) => {
              const on = choices.mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => onChange({ ...choices, mode: m })}
                  onKeyDown={(e) => {
                    // Arrow keys move through the group, as a radio group should.
                    const i = INTERVIEW_MODES.indexOf(m);
                    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                    if (!step) return;
                    e.preventDefault();
                    const next = INTERVIEW_MODES[(i + step + INTERVIEW_MODES.length) % INTERVIEW_MODES.length];
                    onChange({ ...choices, mode: next });
                    (e.currentTarget.parentElement?.children[INTERVIEW_MODES.indexOf(next)] as HTMLElement | undefined)?.focus();
                  }}
                  tabIndex={on ? 0 : -1}
                  className={`rounded-lg border px-4 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 ${
                    on ? "border-accent-500 bg-accent-50" : "border-brand-100 bg-[#ffffff] hover:border-accent-400"
                  }`}
                >
                  <span className="block text-sm font-semibold text-brand-900">{MODE_LABELS[m]}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-warmgray-600">{MODE_BLURBS[m]}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Choice label="Think time" value={choices.thinkSeconds} options={THINK_OPTIONS} onChange={(v) => onChange({ ...choices, thinkSeconds: v })} />
          <Choice label="Answer time" value={choices.answerSeconds} options={ANSWER_OPTIONS} onChange={(v) => onChange({ ...choices, answerSeconds: v })} />
        </div>

        {choices.mode !== "behavioral" && (
          <label className="mt-4 block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-warmgray-500">Technical level</span>
            <select
              value={choices.difficulty}
              onChange={(e) => onChange({ ...choices, difficulty: e.target.value as DifficultyChoice })}
              className="mt-1.5 block min-h-10 w-full rounded-md border border-brand-100 bg-[#ffffff] px-3 text-sm text-brand-900 focus-visible:outline-2 focus-visible:outline-accent-500 sm:w-64"
            >
              {DIFFICULTY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {DIFFICULTY_CHOICE_LABELS[d]}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-warmgray-500">Technicals are picked for the sectors and specialties in your profile.</span>
          </label>
        )}

        {/* Required: how answers are processed. Its own step, and its own tick. */}
        <div className="mt-6 rounded-lg border border-brand-100 bg-brand-50/60 px-4 py-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-brand-900">
            <ShieldCheck size={16} className="text-accent-500" aria-hidden />
            How your answers are handled
          </h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-warmgray-600">
            {ANALYSIS_CONSENT_POINTS.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {analysisAccepted ? (
            <p className="mt-3 text-xs text-success-700">You&apos;ve agreed to this. You can delete your interviews at any time below.</p>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <label htmlFor={agreeId} className="flex items-start gap-2 text-sm text-brand-900">
                <input id={agreeId} type="checkbox" checked={agreeTicked} onChange={(e) => setAgreeTicked(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent-500)]" />
                I agree to my answers being processed this way to get feedback.
              </label>
              <button type="button" onClick={onAcceptAnalysis} disabled={!agreeTicked || consentBusy} className={SECONDARY}>
                {consentBusy ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
                Save
              </button>
            </div>
          )}
        </div>

        {/* Training is asked once, in a dialog at the first Start, and the
            answer is changed in Profile > Connections (VideoTrainingToggle):
            the box that used to sit here was removed at the owner's request on
            5 October 2026. One line says where the setting lives. */}
        <p className="mt-4 text-xs text-warmgray-500">
          Contributing recordings to train Offerly&apos;s coach is optional
          {training === "yes" ? " and on" : training === "no" ? " and off" : ""}.{" "}
          <Link href="/profile/connections#video-training" className="font-medium text-brand-900 hover:underline">
            {training === null ? "Choose in settings" : "Change in settings"}
          </Link>
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="button" onClick={onStart} disabled={!analysisAccepted || starting} className={PRIMARY}>
            {starting ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Video size={15} aria-hidden />}
            Start interview
          </button>
          {!analysisAccepted && <span className="text-xs text-warmgray-500">Agree to how answers are handled first.</span>}
        </div>
      </section>

      <aside className="min-w-0 space-y-6">
        <section className="list-panel border border-brand-100 px-5 py-4">
          <h2 className="text-base font-semibold text-brand-900">Your past interviews</h2>
          {recent.length === 0 ? (
            <p className="mt-2 text-sm text-warmgray-500">Finished interviews appear here with their score.</p>
          ) : (
            <ul className="mt-2 divide-y divide-brand-100">
              {recent.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-2">
                  <button type="button" onClick={() => onOpenRecent(r.id)} className="min-w-0 flex-1 rounded-sm text-left hover:underline focus-visible:outline-2 focus-visible:outline-accent-500">
                    <span className="text-sm font-medium text-brand-900">{MODE_LABELS[r.mode]}</span>
                    <span className="ml-2 text-xs text-warmgray-500">{new Date(r.createdAt).toLocaleDateString()}</span>
                  </button>
                  <span className="text-sm tabular-nums text-brand-900">{r.overall ?? "-"}</span>
                  <button type="button" onClick={() => onDeleteRecent(r.id)} aria-label={`Delete ${MODE_LABELS[r.mode]} interview from ${new Date(r.createdAt).toLocaleDateString()}`} className="rounded-md p-2 text-warmgray-500 hover:bg-brand-50 hover:text-error-600 focus-visible:outline-2 focus-visible:outline-accent-500">
                    <Trash2 size={14} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 border-t border-brand-100 pt-3">
            {confirmDeleteAll ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-brand-900">Delete every interview, transcript and kept recording?</span>
                <button type="button" onClick={() => { setConfirmDeleteAll(false); onDeleteAll(); }} className="rounded-md bg-error-600 px-3 py-1.5 text-sm font-medium text-[#ffffff] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent-500">
                  Delete all
                </button>
                <button type="button" onClick={() => setConfirmDeleteAll(false)} className="rounded-md px-3 py-1.5 text-sm text-warmgray-600 hover:underline">
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmDeleteAll(true)} className="text-xs text-warmgray-500 hover:text-error-600 hover:underline">
                Delete all my video interview data
              </button>
            )}
          </div>
        </section>

        <section className="list-panel border border-brand-100 px-5 py-4">
          <h2 className="text-base font-semibold text-brand-900">Before you start</h2>
          <ul className="mt-2 space-y-2 text-sm text-warmgray-600">
            <li>Look at the camera, not your own picture, when you make your main point.</li>
            <li>Structure behavioral answers: the situation, what you did, what came of it, what you learned.</li>
            <li>Land it under two minutes. Most one-way interviews cut you off at the limit.</li>
            <li>Eyes in the top third of the frame, light in front of you, quiet room.</li>
          </ul>
        </section>
      </aside>
    </div>
  );
}

function Choice({ label, value, options, onChange }: { label: string; value: number; options: readonly number[]; onChange: (v: number) => void }) {
  return (
    <div role="group" aria-label={label}>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-warmgray-500">{label}</p>
      <div className="flex gap-1.5">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onChange(o)}
            aria-pressed={value === o}
            className={`min-h-10 flex-1 rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 ${
              value === o ? "border-accent-500 bg-accent-500 text-[#ffffff]" : "border-brand-100 bg-[#ffffff] text-brand-900 hover:border-accent-400"
            }`}
          >
            {o < 60 ? `${o}s` : `${o / 60} min`}
          </button>
        ))}
      </div>
    </div>
  );
}
