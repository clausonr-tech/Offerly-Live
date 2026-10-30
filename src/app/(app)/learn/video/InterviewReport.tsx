"use client";

import { Check, Download, Loader2, Minus, RotateCcw, Trash2 } from "lucide-react";

import {
  MODE_LABELS,
  SCORE_CATEGORY_LABELS,
  answerStatusLabel,
  type ClientAnswer,
  type ClientQuestion,
  type ClientSession,
  type ScoreCategory,
} from "@/lib/video-interview/types";
import { PRIMARY, SECONDARY } from "./InterviewSetup";

/** What happened to an answer's training copy in this page visit. */
export type TrainingCopyState = "kept" | "failed" | "no_storage" | "retrying";

const CATEGORY_ORDER: ScoreCategory[] = ["grammarClarity", "pacePauses", "fillers", "structure", "relevance", "completeness", "logic", "concision"];

function band(score: number): string {
  if (score >= 80) return "bg-success-600";
  if (score >= 60) return "bg-accent-500";
  if (score >= 40) return "bg-gold-500";
  return "bg-error-600";
}

export default function InterviewReport({
  session,
  localVideos,
  trainingCopy = {},
  canRetryTraining = () => false,
  onRetryTraining,
  onNew,
  onDelete,
}: {
  session: ClientSession;
  /** Answer video, by question id - held in this tab for playback. */
  localVideos: Record<string, { url: string; ext: string }>;
  trainingCopy?: Record<string, TrainingCopyState>;
  canRetryTraining?: (questionId: string) => boolean;
  onRetryTraining?: (questionId: string) => void;
  onNew: () => void;
  onDelete: () => void;
}) {
  const r = session.report;
  const byQuestion = new Map(session.answers.map((a) => [a.questionId, a]));
  const anyScored = session.answers.some((a) => a.status === "complete");

  return (
    <div className="space-y-6">
      <section className="list-panel border border-brand-100 px-5 py-5 sm:px-6" aria-labelledby="vi-report-title">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-warmgray-500">
              {MODE_LABELS[session.mode]} interview · {new Date(session.createdAt).toLocaleDateString()}
            </p>
            <h2 id="vi-report-title" className="mt-1 text-lg font-semibold text-brand-900">
              Your interview report
            </h2>
            <p className="mt-1 text-sm text-warmgray-600">Tailored to: {session.tailoredTo}</p>
          </div>
          {r?.overall != null && (
            <div className="text-right">
              <p className="text-4xl font-semibold tabular-nums text-brand-900">{r.overall}</p>
              <p className="text-xs text-warmgray-500">overall, out of 100</p>
            </div>
          )}
        </div>

        {!anyScored ? (
          <p className="mt-4 text-sm text-warmgray-600">
            No answers were scored in this interview.{" "}
            {session.answers.some((a) => a.practiceOnly)
              ? "Speech-to-text isn't set up, so your answers were recorded on this device for practice but not scored."
              : session.answers.some((a) => a.status === "skipped")
                ? "Skipped answers aren't graded."
                : ""}
          </p>
        ) : r ? (
          <>
            {r.deliveryOnlyCount > 0 && (
              <p role="note" className="mt-4 rounded-md border border-gold-200 bg-gold-50 px-3 py-2 text-sm text-brand-900">
                {r.deliveryOnlyCount === 1 ? "One answer was" : `${r.deliveryOnlyCount} answers were`} scored on delivery only, because content feedback wasn&apos;t available.
              </p>
            )}
            <dl className="mt-5 grid gap-x-8 gap-y-3 sm:grid-cols-2">
              {CATEGORY_ORDER.filter((c) => r.categories[c] != null).map((c) => (
                <ScoreBar key={c} label={SCORE_CATEGORY_LABELS[c]} value={r.categories[c]!} />
              ))}
            </dl>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <Stat label="Average pace" value={r.averageWpm != null ? `${r.averageWpm} wpm` : "-"} hint="130-160 reads as confident" />
              <Stat label="Filler words" value={String(r.totalFillers)} hint="as transcribed - may undercount" />
              <Stat label="Possible stutters (estimate)" value={String(r.disfluencyEstimate)} hint="repeated or cut-off words; an estimate, not a diagnosis" />
            </div>
            {(r.topStrengths.length > 0 || r.topImprovements.length > 0) && (
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <List title="What went well" items={r.topStrengths} />
                <List title="Work on next" items={r.topImprovements} />
              </div>
            )}
          </>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={onNew} className={PRIMARY}>
            <RotateCcw size={15} aria-hidden />
            New interview
          </button>
          <button type="button" onClick={onDelete} className={SECONDARY}>
            <Trash2 size={14} aria-hidden />
            Delete this interview
          </button>
        </div>
      </section>

      <ol className="space-y-4">
        {session.questions.map((q) => (
          <AnswerCard
            key={q.id}
            question={q}
            answer={byQuestion.get(q.id)}
            video={localVideos[q.id]}
            training={trainingCopy[q.id]}
            onRetryTraining={onRetryTraining && canRetryTraining(q.id) ? () => onRetryTraining(q.id) : undefined}
          />
        ))}
      </ol>
    </div>
  );
}

function AnswerCard({
  question,
  answer,
  video,
  training,
  onRetryTraining,
}: {
  question: ClientQuestion;
  answer?: ClientAnswer;
  video?: { url: string; ext: string };
  training?: TrainingCopyState;
  onRetryTraining?: () => void;
}) {
  const f = answer?.feedback;
  return (
    <li className="list-panel border border-brand-100 px-5 py-4 sm:px-6">
      <details open={question.position === 0} className="group">
        <summary className="flex cursor-pointer list-none items-start gap-3 rounded-sm focus-visible:outline-2 focus-visible:outline-accent-500">
          <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-900">{question.position + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-medium uppercase tracking-wide text-warmgray-500">
              {question.kind === "technical" ? `Technical · ${question.sectorLabel ?? ""} · ${question.topic}` : `Behavioral · ${question.topic}`}
            </span>
            <span className="mt-0.5 block text-sm text-brand-900">{question.prompt}</span>
          </span>
          <span className="shrink-0 text-lg font-semibold tabular-nums text-brand-900">
            {f?.overall ??
              (answer?.status === "skipped" || answer?.status === "failed" ? (
                <span className={`text-xs font-normal ${answer.status === "failed" ? "text-error-600" : answer.practiceOnly ? "text-accent-600" : "text-warmgray-500"}`}>
                  {answerStatusLabel(answer)}
                </span>
              ) : (
                "-"
              ))}
          </span>
        </summary>

        <div className="mt-4 space-y-4 pl-9">
          {video && (
            <div className="space-y-2">
              <video src={video.url} controls playsInline className="aspect-video w-full max-w-xl rounded-md bg-[#0b1526] object-contain" />
              <a href={video.url} download={`interview-answer-${question.position + 1}.${video.ext}`} className="inline-flex items-center gap-1.5 text-xs text-warmgray-600 hover:underline">
                <Download size={12} aria-hidden /> Download this answer (stays on this device)
              </a>
            </div>
          )}
          {answer?.error && <p className="text-sm text-error-600">{answer.error}</p>}
          {f && (
            <>
              <p className="text-sm text-brand-900">{f.summary}</p>
              <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
                {CATEGORY_ORDER.filter((c) => f.scores[c] != null).map((c) => (
                  <ScoreBar key={c} label={SCORE_CATEGORY_LABELS[c]} value={f.scores[c]!} small />
                ))}
              </dl>
              <div className="grid gap-4 sm:grid-cols-2">
                <List title="Strengths" items={f.strengths} />
                <List title="To improve" items={f.improvements} />
              </div>
              {f.grammarNotes.length > 0 && <List title="Grammar & clarity notes" items={f.grammarNotes} />}
              {f.conceptCoverage && (
                <p className="text-sm text-warmgray-600">
                  Key concepts conveyed: <strong className="text-brand-900">{f.conceptCoverage.covered} of {f.conceptCoverage.total}</strong>
                </p>
              )}
              {f.factualErrors && f.factualErrors.length > 0 && <List title="Stated incorrectly" items={f.factualErrors} tone="error" />}
              {f.star && (
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-warmgray-500">Answer structure (STAR)</p>
                  <ul className="mt-1.5 flex flex-wrap gap-2">
                    {(
                      [
                        ["situation", "Situation"],
                        ["task", "Task"],
                        ["action", "Action"],
                        ["result", "Result"],
                        ["reflection", "Reflection"],
                      ] as const
                    ).map(([k, label]) => (
                      <li key={k} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${f.star![k] ? "border-success-200 bg-success-50 text-success-800" : "border-brand-100 text-warmgray-500"}`}>
                        {f.star![k] ? <Check size={12} aria-hidden /> : <Minus size={12} aria-hidden />}
                        {label}
                        <span className="sr-only">{f.star![k] ? " present" : " missing"}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="grid gap-3 text-sm sm:grid-cols-4">
                <Stat label="Pace" value={f.delivery.wordsPerMinute != null ? `${f.delivery.wordsPerMinute} wpm` : "-"} />
                <Stat label="Pauses (1.5s+)" value={f.delivery.pauses ? `${f.delivery.pauses.count}${f.delivery.pauses.count ? `, longest ${f.delivery.pauses.longest}s` : ""}` : "n/a"} />
                <Stat label="Fillers" value={f.delivery.fillers.total ? f.delivery.fillers.top.map((t) => `${t.word} ×${t.count}`).join(", ") : "none heard"} />
                <Stat label="Possible stutters (est.)" value={String(f.delivery.disfluencyEstimate.count)} />
              </div>
              {f.delivery.repeatedPhrases.length > 0 && (
                <p className="text-sm text-warmgray-600">
                  Repeated phrases: {f.delivery.repeatedPhrases.map((p) => `“${p.phrase}” ×${p.count}`).join(", ")}
                </p>
              )}
            </>
          )}
          {answer?.transcript && (
            <details className="rounded-md border border-brand-100 bg-brand-50/50 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-brand-900">Transcript</summary>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-warmgray-600">{answer.transcript}</p>
            </details>
          )}
          {!answer?.retained && (training === "failed" || training === "retrying") && (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-gold-200 bg-gold-50 px-3 py-2 text-sm text-brand-900">
              <span className="min-w-0 flex-1">
                {training === "retrying"
                  ? "Saving the training copy…"
                  : onRetryTraining
                    ? "The training copy of this answer wasn't saved. The recording is still on this device."
                    : "The training copy of this answer wasn't saved, and the recording is no longer on this device."}
              </span>
              {onRetryTraining && (
                <button
                  type="button"
                  onClick={onRetryTraining}
                  disabled={training === "retrying"}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-brand-100 bg-[#ffffff] px-3 text-sm font-medium text-brand-900 hover:border-accent-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:opacity-60"
                >
                  {training === "retrying" ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RotateCcw size={13} aria-hidden />}
                  Retry saving training copy
                </button>
              )}
            </div>
          )}
          {answer?.retained && <p className="text-xs text-warmgray-500">This answer&apos;s camera recording is kept privately for training, as you chose. Turn training off, or delete this interview, to delete it.</p>}
        </div>
      </details>
    </li>
  );
}

function ScoreBar({ label, value, small }: { label: string; value: number; small?: boolean }) {
  return (
    <div>
      <dt className={`flex justify-between ${small ? "text-xs" : "text-sm"} text-brand-900`}>
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </dt>
      <dd className="mt-1 h-2 overflow-hidden rounded-full bg-brand-50" role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${band(value)}`} style={{ width: `${Math.max(2, value)}%` }} />
      </dd>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-brand-100 px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-warmgray-500">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-brand-900">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-warmgray-500">{hint}</p>}
    </div>
  );
}

function List({ title, items, tone }: { title: string; items: string[]; tone?: "error" }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-warmgray-500">{title}</p>
      <ul className={`mt-1 list-disc space-y-1 pl-5 text-sm ${tone === "error" ? "text-error-700" : "text-brand-900"}`}>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}
