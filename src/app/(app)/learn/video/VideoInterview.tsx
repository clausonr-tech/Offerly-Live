"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Camera, CameraOff, Circle, Loader2, RotateCcw, SkipForward, Square } from "lucide-react";

import { answerLeft, countdownValue, initialMachine, machine, MIN_RECORD_SECONDS } from "@/lib/video-interview/interview-machine";
import { createInterviewEnder, stopActiveRecorders } from "@/lib/video-interview/end-interview";
import {
  QUESTIONS_PER_INTERVIEW,
  VIDEO_AUDIO_BITS_PER_SECOND,
  answerStatusLabel,
  VIDEO_BITS_PER_SECOND,
  maxVideoBytesFor,
  type ClientSession,
  type CoachCapabilities,
  type TrainingChoice,
} from "@/lib/video-interview/types";
import type { ConsentState } from "@/lib/video-interview/consent";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";

import {
  acceptAnalysisConsent,
  beginVideoQuestion,
  confirmTrainingUpload,
  deleteAllVideoInterviews,
  deleteVideoInterview,
  finishVideoInterview,
  openVideoInterview,
  recordPracticeVideoAnswer,
  requestTrainingUpload,
  skipVideoQuestion,
  startVideoInterview,
  submitVideoAnswer,
} from "./actions";
import InterviewReport, { type TrainingCopyState } from "./InterviewReport";
import InterviewSetup, { PRIMARY, SECONDARY, type RecentInterview, type SetupChoices } from "./InterviewSetup";
import RobotInterviewer, { useInterviewerVoice } from "./RobotInterviewer";
import TrainingConsentDialog from "./TrainingConsentDialog";
import { createStartFlow, type StartFlowState } from "@/lib/video-interview/start-flow";

/**
 * The video interview coach: the HireVue-style one-way format banks screen
 * with, with an interviewer who asks out loud and feedback on every answer.
 *
 * What leaves the browser: only each answer's AUDIO, recorded separately from
 * the video, uploaded once the answer ends. The camera video never does - it
 * is kept in this tab's memory for playback and download, and is gone when
 * the student leaves the page.
 */

type CameraState = "off" | "requesting" | "ready" | "denied" | "notfound" | "unsupported" | "error";

const CAMERA_MESSAGES: Partial<Record<CameraState, string>> = {
  denied: "Camera or microphone access is blocked. Click the camera icon in your browser's address bar, allow both for this site, then try again.",
  notfound: "No camera or microphone was found. Plug one in, or check it isn't switched off, then try again.",
  unsupported: "This browser can't use a camera here. Try the latest Chrome, Edge, Firefox or Safari.",
  error: "Couldn't start the camera. Close other apps that might be using it (Zoom, Teams, FaceTime) and try again.",
};

function pickType(candidates: string[]): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return candidates.find((t) => MediaRecorder.isTypeSupported(t));
}

function clock(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
}

/** The first question still to answer: pending, or failed and not yet skipped. */
function firstOpen(session: ClientSession): number {
  const i = session.answers.findIndex((a) => a.status === "pending" || a.status === "failed" || a.status === "processing");
  return i === -1 ? session.questions.length : i;
}

export default function VideoInterview({
  initialConsent,
  initialActive,
  initialRecent,
  capabilities,
}: {
  initialConsent: ConsentState;
  initialActive: ClientSession | null;
  initialRecent: RecentInterview[];
  capabilities: CoachCapabilities;
}) {
  const transcriptionReady = capabilities.transcription;
  const [view, setView] = useState<"setup" | "interview" | "report">("setup");
  const [choices, setChoices] = useState<SetupChoices>({ mode: "both", thinkSeconds: 30, answerSeconds: 120, difficulty: "auto" });
  const [consent, setConsent] = useState(initialConsent);
  const [consentBusy, setConsentBusy] = useState(false);
  const [recent, setRecent] = useState(initialRecent);
  const [resumable, setResumable] = useState<ClientSession | null>(initialActive);
  const [session, setSession] = useState<ClientSession | null>(null);
  const [index, setIndex] = useState(0);
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [camera, setCamera] = useState<CameraState>("off");
  const [localVideos, setLocalVideos] = useState<Record<string, { url: string; ext: string }>>({});
  // Which answers' audio is still in memory, so a failed upload can be retried.
  const [heldAudio, setHeldAudio] = useState<ReadonlySet<string>>(new Set());
  // Which answers' camera recording is still in memory (for a training retry).
  const [heldVideo, setHeldVideo] = useState<ReadonlySet<string>>(new Set());
  const [m, dispatch] = useReducer(machine, initialMachine(30, 120));
  // Ending the interview: in flight, and the error if it failed.
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const [ender] = useState(() => createInterviewEnder(finishVideoInterview));

  const voice = useInterviewerVoice();
  const { speak, stop: stopVoice } = voice;
  const reducedMotion = usePrefersReducedMotion();

  const streamRef = useRef<MediaStream | null>(null);
  const liveRef = useRef<HTMLVideoElement>(null);
  const recRef = useRef<{ video: MediaRecorder | null; audio: MediaRecorder; stopped: Promise<void>; startedAt: number; videoType: string; audioType: string } | null>(null);
  const audioBlobs = useRef(new Map<string, { blob: Blob; durationMs: number }>());
  // The camera recording, kept in memory for playback - and uploaded ONLY
  // under a current training opt-in with storage configured.
  const videoBlobs = useRef(new Map<string, { blob: Blob; durationMs: number }>());
  // Per answer: what happened to its training copy, for the saved overlay.
  const [trainingCopy, setTrainingCopy] = useState<Record<string, TrainingCopyState>>({});
  // The last upload granted per answer, so a retry can re-confirm it.
  const lastUpload = useRef(new Map<string, string>());
  const begun = useRef(new Map<string, Promise<unknown>>());
  const processingFor = useRef<string | null>(null);
  const videoUrls = useRef<string[]>([]);

  const question = session?.questions[index] ?? null;

  // ---------- camera ----------

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamera("off");
  }, []);

  useEffect(() => {
    const urls = videoUrls.current;
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  // The live preview attaches whenever its element is mounted.
  useEffect(() => {
    if (liveRef.current && streamRef.current && liveRef.current.srcObject !== streamRef.current) {
      liveRef.current.srcObject = streamRef.current;
    }
  });

  const turnOnCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setCamera("unsupported");
      return;
    }
    setCamera("requesting");
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      setCamera("ready");
    } catch (e) {
      const name = (e as DOMException)?.name;
      setCamera(name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" || name === "OverconstrainedError" ? "notfound" : "error");
    }
  };

  // ---------- asking ----------

  const ask = useCallback(
    (s: ClientSession, i: number) => {
      const q = s.questions[i];
      if (!q) return;
      setIndex(i);
      setNotice(null);
      dispatch({ type: "ASK", thinkSeconds: s.thinkSeconds, answerSeconds: s.answerSeconds });
      // The server notes when the question appeared; an answer cannot be
      // longer than the time since.
      if (!begun.current.has(q.id)) begun.current.set(q.id, beginVideoQuestion(q.id));
      speak(`Question ${i + 1}. ${q.prompt}`, () => dispatch({ type: "SPEECH_DONE" }));
    },
    [speak],
  );

  // ---------- the clock ----------

  useEffect(() => {
    if (m.phase !== "thinking" && m.phase !== "recording") return;
    const id = window.setInterval(() => dispatch({ type: "TICK" }), 1000);
    return () => window.clearInterval(id);
  }, [m.phase]);

  // ---------- recording ----------

  useEffect(() => {
    if (m.phase !== "recording" || recRef.current) return;
    if (!streamRef.current) {
      dispatch({ type: "RECORDER_FAILED", error: "The camera went off. Turn it on again, then record this answer." });
      return;
    }
    stopVoice();
    const stream = streamRef.current;
    try {
      const audioType = pickType(["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"]);
      const videoType = pickType(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]);
      const audio = new MediaRecorder(new MediaStream(stream.getAudioTracks()), { ...(audioType ? { mimeType: audioType } : {}), audioBitsPerSecond: 48_000 });
      // The video is only for playback here; kept modest so five answers fit in memory.
      let video: MediaRecorder | null = null;
      try {
        // Rates the server's size limit is computed from (maxVideoBytesFor).
        video = new MediaRecorder(stream, {
          ...(videoType ? { mimeType: videoType } : {}),
          videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
          audioBitsPerSecond: VIDEO_AUDIO_BITS_PER_SECOND,
        });
      } catch {
        video = null; // Audio alone still gets feedback.
      }
      const audioChunks: Blob[] = [];
      const videoChunks: Blob[] = [];
      audio.ondataavailable = (e) => e.data.size > 0 && audioChunks.push(e.data);
      if (video) video.ondataavailable = (e) => e.data.size > 0 && videoChunks.push(e.data);
      const stopped = Promise.all([
        new Promise<void>((r) => (audio.onstop = () => r())),
        video ? new Promise<void>((r) => (video!.onstop = () => r())) : Promise.resolve(),
      ]).then(() => {
        const rec = recRef.current;
        if (!rec || !question) return;
        const durationMs = Date.now() - rec.startedAt;
        audioBlobs.current.set(question.id, { blob: new Blob(audioChunks, { type: audio.mimeType || rec.audioType || "audio/webm" }), durationMs });
        setHeldAudio((h) => new Set(h).add(question.id));
        if (video && videoChunks.length) {
          const videoBlob = new Blob(videoChunks, { type: video.mimeType || rec.videoType || "video/webm" });
          videoBlobs.current.set(question.id, { blob: videoBlob, durationMs });
          setHeldVideo((h) => new Set(h).add(question.id));
          const url = URL.createObjectURL(videoBlob);
          videoUrls.current.push(url);
          setLocalVideos((v) => ({ ...v, [question.id]: { url, ext: (video.mimeType || rec.videoType).includes("mp4") ? "mp4" : "webm" } }));
        }
        recRef.current = null;
        dispatch({ type: "RECORDED" });
      });
      recRef.current = { video, audio, stopped, startedAt: Date.now(), videoType: videoType ?? "", audioType: audioType ?? "" };
      audio.start(1000);
      video?.start(1000);
    } catch {
      recRef.current = null;
      dispatch({ type: "RECORDER_FAILED", error: "This browser couldn't record. Try the latest Chrome, Edge, Firefox or Safari." });
    }
  }, [m.phase, question, stopVoice]);

  useEffect(() => {
    if (m.phase !== "stopping") return;
    const rec = recRef.current;
    if (!rec) return;
    if (rec.audio.state !== "inactive") rec.audio.stop();
    if (rec.video && rec.video.state !== "inactive") rec.video.stop();
  }, [m.phase]);

  // ---------- processing ----------

  /**
   * Uploads this answer's camera recording to private storage: the server
   * grants one presigned PUT, the browser sends the file straight there, and
   * the server checks it before keeping it.
   *
   * Safe to call again after a failure (the report's retry button): it first
   * re-confirms the last upload, in case the file did arrive; only if the
   * server says that upload is gone does it ask for a new one. Every step
   * goes through the same server checks, and the server allows one recording
   * per answer, so a retry can never store a second copy.
   */
  const keepTrainingCopy = useCallback(async (questionId: string): Promise<"kept" | "failed"> => {
    const video = videoBlobs.current.get(questionId);
    if (!video || video.blob.size === 0 || video.blob.size > maxVideoBytesFor(video.durationMs)) return "failed";

    const previous = lastUpload.current.get(questionId);
    if (previous) {
      const again = await confirmTrainingUpload(previous).catch(() => null);
      if (again?.ok) {
        lastUpload.current.delete(questionId);
        return "kept";
      }
      if (again && again.code !== "not_found") return "failed"; // still retryable later
      lastUpload.current.delete(questionId);
    }

    const grant = await requestTrainingUpload({ questionId, contentType: video.blob.type, size: video.blob.size, durationMs: video.durationMs }).catch(() => null);
    if (!grant) return "failed";
    if (!grant.ok) return grant.code === "already_stored" ? "kept" : "failed";
    lastUpload.current.set(questionId, grant.data.uploadId);
    const put = await fetch(grant.data.url, { method: grant.data.method, headers: grant.data.headers, body: video.blob }).catch(() => null);
    // Confirm even after a failed PUT: the server then removes the pending
    // record at once instead of waiting for it to expire.
    const confirmed = await confirmTrainingUpload(grant.data.uploadId).catch(() => null);
    if (confirmed?.ok || confirmed?.code === "not_found") lastUpload.current.delete(questionId);
    return put?.ok && confirmed?.ok ? "kept" : "failed";
  }, []);

  const retryTrainingCopy = useCallback(
    async (questionId: string) => {
      setTrainingCopy((t) => ({ ...t, [questionId]: "retrying" }));
      const outcome = await keepTrainingCopy(questionId);
      setTrainingCopy((t) => ({ ...t, [questionId]: outcome }));
      if (outcome === "kept") {
        setSession((cur) => cur && { ...cur, answers: cur.answers.map((a) => (a.questionId === questionId ? { ...a, retained: true } : a)) });
      }
    },
    [keepTrainingCopy],
  );

  const process = useCallback(async () => {
    if (!session || !question) return;
    if (processingFor.current === question.id) return;
    processingFor.current = question.id;
    try {
      if (!transcriptionReady) {
        // Nothing can transcribe it, so nothing is uploaded: the server notes
        // a practice answer (not a skip) and the recording stays on this
        // device for playback.
        const res = await recordPracticeVideoAnswer(question.id);
        if (!res.ok) return dispatch({ type: "PROCESS_FAILED", error: res.error, retryable: res.retryable });
        setSession(res.data);
        return dispatch({ type: "PROCESSED" });
      }
      const recorded = audioBlobs.current.get(question.id);
      if (!recorded) return dispatch({ type: "PROCESS_FAILED", error: "The recording for this answer isn't on this device any more. Record it again.", retryable: false });
      await begun.current.get(question.id)?.catch(() => null);
      const form = new FormData();
      form.set("questionId", question.id);
      form.set("durationMs", String(recorded.durationMs));
      form.set("audio", new File([recorded.blob], "answer", { type: recorded.blob.type }));
      const res = await submitVideoAnswer(form).catch(() => ({ ok: false as const, error: "The upload didn't go through. Check your connection and try again.", retryable: true }));
      if (!res.ok) return dispatch({ type: "PROCESS_FAILED", error: res.error, retryable: res.retryable });
      setSession(res.data.session);
      // Training copy: only with the opt-in on. A failure here never fails
      // the answer - it is already saved and scored.
      if (session.training.optedIn) {
        const outcome = capabilities.trainingStorage ? await keepTrainingCopy(question.id) : "no_storage";
        setTrainingCopy((t) => ({ ...t, [question.id]: outcome }));
        if (outcome === "kept") {
          setSession((cur) => cur && { ...cur, answers: cur.answers.map((a) => (a.questionId === question.id ? { ...a, retained: true } : a)) });
        }
      }
      dispatch({ type: "PROCESSED" });
    } finally {
      processingFor.current = null;
    }
  }, [question, session, transcriptionReady, capabilities.trainingStorage, keepTrainingCopy]);

  useEffect(() => {
    if (m.phase === "processing") void process();
  }, [m.phase, process]);

  /**
   * Opens the report - only for a session the server confirms is complete.
   * An unfinished one is finished first through the ender, which sends one
   * request however many times this is called; if that fails the student
   * stays on the interview with the error and a retry, never a report.
   */
  const showReport = useCallback(
    async (s: ClientSession): Promise<boolean> => {
      let final = s;
      if (s.status !== "complete") {
        setEnding(true);
        setEndError(null);
        const out = await ender.end(s.id);
        setEnding(false);
        if (!out.ok) {
          // Stay on the interview, stopped, with the error and a retry - also
          // when this was the automatic finish after the last answer.
          dispatch({ type: "END" });
          setEndError(out.error);
          return false;
        }
        final = out.session;
      }
      setSession(final);
      setView("report");
      stopCamera();
      setRecent((r) => [{ id: final.id, mode: final.mode, overall: final.report?.overall ?? null, createdAt: final.createdAt }, ...r.filter((x) => x.id !== final.id)].slice(0, 8));
      return true;
    },
    [stopCamera, ender],
  );

  // After an answer is processed: a beat to show it was saved, then onward.
  useEffect(() => {
    if (m.phase !== "done" || !session) return;
    const next = firstOpen(session);
    const id = window.setTimeout(() => (next >= session.questions.length ? void showReport(session) : ask(session, next)), reducedMotion ? 400 : 1200);
    return () => window.clearTimeout(id);
  }, [m.phase, session, ask, showReport, reducedMotion]);

  // ---------- setup actions ----------

  const acceptConsent = async () => {
    setConsentBusy(true);
    const res = await acceptAnalysisConsent();
    setConsentBusy(false);
    if (res.ok) setConsent(res.data);
    else setNotice(res.error);
  };

  // The first "Start interview" opens the training question. No session
  // exists, and the camera is not asked for, until it's answered. After that
  // the standing answer is used and Start starts straight away - the server
  // applies the stored answer whatever the page sends (sessions.startSession).
  const [startFlowView, setStartFlowView] = useState<{ state: StartFlowState; error: string | null }>({ state: "closed", error: null });
  const [pendingChoice, setPendingChoice] = useState<TrainingChoice | null>(null);
  // Made once; the student's CURRENT setup is passed in with each choice.
  const [startFlow] = useState(() =>
    createStartFlow<ClientSession, SetupChoices>(
      (trainingChoice, startToken, setup) => startVideoInterview({ ...setup, trainingChoice, startToken }),
      setStartFlowView,
    ),
  );
  const start = () => {
    setNotice(null);
    startFlow.open();
    if (consent.training) void chooseTraining(consent.training.choice);
  };
  const chooseTraining = async (choice: TrainingChoice) => {
    const standing = consent.training;
    setPendingChoice(choice);
    const res = await startFlow.choose(choice, choices);
    setPendingChoice(null);
    if (res.ok) {
      if (!standing) setConsent((c) => ({ ...c, training: { choice, decidedAt: new Date().toISOString() } }));
      enterInterview(res.data);
    } else if (standing) {
      // No dialog to show the error in: say it on the page, and close the flow.
      setNotice(res.error);
      startFlow.cancel();
    }
  };

  const enterInterview = (s: ClientSession) => {
    setSession(s);
    setResumable(null);
    setStarted(false);
    setIndex(firstOpen(s));
    dispatch({ type: "ASK", thinkSeconds: s.thinkSeconds, answerSeconds: s.answerSeconds });
    setView("interview");
  };

  const openRecent = async (id: string) => {
    const res = await openVideoInterview(id);
    if (!res.ok) return setNotice(res.error);
    setSession(res.data);
    setView("report");
  };

  const removeInterview = async (id: string) => {
    const res = await deleteVideoInterview(id);
    if (!res.ok) return setNotice(res.error);
    setRecent((r) => r.filter((x) => x.id !== id));
    if (resumable?.id === id) setResumable(null);
    if (session?.id === id) {
      setSession(null);
      setView("setup");
    }
    setNotice("Interview deleted.");
  };

  const removeAll = async () => {
    const res = await deleteAllVideoInterviews();
    if (!res.ok) return setNotice(res.error);
    setRecent([]);
    setResumable(null);
    setNotice("All your video interview data was deleted.");
  };

  const skipCurrent = async () => {
    if (!question) return;
    setBusy(true);
    stopVoice();
    const res = await skipVideoQuestion(question.id);
    setBusy(false);
    if (!res.ok) return setNotice(res.error);
    setSession(res.data);
    const next = firstOpen(res.data);
    if (next >= res.data.questions.length) void showReport(res.data);
    else ask(res.data, next);
  };

  /**
   * End interview. Everything the current question had running stops first,
   * synchronously, before any request: the machine moves to "ended" (so the
   * clock, the 3-2-1 and the automatic recording can't advance), speech is
   * cancelled, and any recorder is stopped. Only then is the server asked to
   * finish - and a slow or failed answer from it can't restart anything.
   */
  const endEarly = async () => {
    if (!session || ending) return;
    dispatch({ type: "END" });
    stopVoice();
    const rec = recRef.current;
    stopActiveRecorders([rec?.audio, rec?.video]);
    await showReport(session);
  };

  /** After a failed end: carry on with the interview where it stopped. */
  const resumeAfterFailedEnd = () => {
    if (!session) return;
    setEndError(null);
    ask(session, firstOpen(session));
  };

  // ---------- render ----------

  if (view === "setup") {
    return (
      <div className="space-y-4">
        {notice && (
          <p role="status" className="rounded-md border border-brand-100 bg-[#ffffff] px-4 py-2 text-sm text-brand-900 shadow-card">
            {notice}
          </p>
        )}
        {resumable && (
          <div className="list-panel flex flex-wrap items-center gap-3 border border-accent-200 bg-accent-50 px-5 py-3">
            <p className="flex-1 text-sm text-brand-900">
              You have an unfinished interview - {resumable.answers.filter((a) => a.status === "complete" || a.status === "skipped").length} of {resumable.questions.length} answered.
            </p>
            <button type="button" className={PRIMARY} onClick={() => enterInterview(resumable)}>
              Resume
            </button>
            <button type="button" className={SECONDARY} onClick={() => removeInterview(resumable.id)}>
              Discard
            </button>
          </div>
        )}
        <TrainingConsentDialog
          // Only the first time. With a standing answer, Start goes straight in.
          open={startFlowView.state !== "closed" && !consent.training}
          storageAvailable={capabilities.trainingStorage}
          busy={startFlowView.state === "starting"}
          pendingChoice={pendingChoice}
          error={startFlowView.error}
          onChoose={chooseTraining}
          onCancel={() => startFlow.cancel()}
        />
        <InterviewSetup
          choices={choices}
          onChange={setChoices}
          onStart={start}
          starting={startFlowView.state === "starting"}
          analysisAccepted={Boolean(consent.analysis)}
          onAcceptAnalysis={acceptConsent}
          training={consent.training?.choice ?? null}
          consentBusy={consentBusy}
          transcriptionReady={transcriptionReady}
          recent={recent}
          onOpenRecent={openRecent}
          onDeleteRecent={removeInterview}
          onDeleteAll={removeAll}
        />
      </div>
    );
  }

  if (view === "report" && session) {
    return (
      <InterviewReport
        session={session}
        localVideos={localVideos}
        trainingCopy={trainingCopy}
        // Retry only while this tab still holds the recording, under a
        // current opt-in, with storage to put it in.
        canRetryTraining={(id) => Boolean(session.training.optedIn && capabilities.trainingStorage && heldVideo.has(id))}
        onRetryTraining={retryTrainingCopy}
        onNew={() => {
          setSession(null);
          setView("setup");
        }}
        onDelete={() => removeInterview(session.id)}
      />
    );
  }

  if (!session) return null;

  const cd = countdownValue(m);
  // What leaves this device, stated for the student's actual settings.
  const cameraDisclosure = !session.training.optedIn
    ? "Your video stays on this device; only each answer's audio is sent, for transcription and feedback."
    : capabilities.trainingStorage
      ? "Each answer's audio is sent for feedback, and because training is on, its video and voice are also uploaded privately for training after it's processed."
      : "Training is on, but recording storage isn't available, so no training copy can be kept. Only each answer's audio is sent, for feedback.";
  const answer = question ? session.answers.find((a) => a.questionId === question.id) : undefined;
  const canRetry = m.phase === "failed" && m.retryable && question && heldAudio.has(question.id);
  const label = question
    ? `Question ${index + 1} of ${session.questions.length || QUESTIONS_PER_INTERVIEW} · ${question.kind === "technical" ? `Technical${question.sectorLabel ? ` · ${question.sectorLabel}` : ""}` : "Behavioral"}`
    : "Your interviewer";

  return (
    <div className="space-y-4">
      {/* Progress: one dot per question. */}
      <ol className="flex items-center gap-2" aria-label="Interview progress">
        {session.questions.map((q, i) => {
          const ans = session.answers[i];
          const st = ans?.status;
          const cls =
            st === "complete"
              ? "bg-success-600"
              : st === "skipped"
                ? ans?.practiceOnly
                  ? "bg-accent-200"
                  : "bg-warmgray-300"
                : st === "failed"
                  ? "bg-error-600"
                  : i === index && started
                    ? "bg-accent-500"
                    : "bg-brand-100";
          return (
            <li key={q.id} className={`h-1.5 flex-1 rounded-full ${cls}`}>
              <span className="sr-only">
                Question {i + 1}: {st === "pending" || !st ? (i === index ? "current" : "to come") : answerStatusLabel(ans)}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        {/* The interviewer, beside the camera on wide screens, above it on narrow ones. */}
        <section className="list-panel border border-brand-100 px-5 py-5" aria-label="Interviewer">
          <RobotInterviewer
            prompt={started ? (question?.prompt ?? null) : null}
            label={started ? label : "Your interviewer"}
            speaking={voice.speaking}
            muted={voice.muted}
            voiceAvailable={voice.available}
            // Replaying while it is still being asked must still start think
            // time when it finishes, so it carries the same completion.
            onReplay={() => question && speak(question.prompt, () => dispatch({ type: "SPEECH_DONE" }))}
            onToggleMute={voice.toggleMute}
          />
          {started && question && (m.phase === "asking" || m.phase === "thinking") && (
            <p className="mt-4 text-sm text-warmgray-600 lg:text-center">
              {m.phase === "asking" ? "Listen to the question - think time starts when it's read." : `Think time · ${clock(m.thinkLeft)}. Recording starts automatically.`}
            </p>
          )}
        </section>

        <section className="list-panel overflow-hidden border border-brand-100" aria-label="Your camera">
          <div className="relative aspect-video w-full bg-[#0b1526]">
            {camera === "ready" ? (
              // Mirrored like every video-call preview; the recording is not.
              <video ref={liveRef} autoPlay muted playsInline className="h-full w-full -scale-x-100 object-cover" />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <CameraOff size={28} className="text-[#c3cfe2]" aria-hidden />
                <p className="max-w-md text-sm text-[#c3cfe2]">
                  {CAMERA_MESSAGES[camera] ?? `Your browser will ask to use your camera and microphone. ${cameraDisclosure}`}
                </p>
                <button type="button" onClick={turnOnCamera} disabled={camera === "requesting"} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[#ffffff] px-5 py-2.5 text-sm font-semibold text-[#0b1526] shadow-card hover:bg-[#dbe4f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ffffff] disabled:opacity-70">
                  {camera === "requesting" ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Camera size={15} aria-hidden />}
                  {camera === "off" || camera === "requesting" ? "Turn on camera" : "Try again"}
                </button>
              </div>
            )}

            {cd != null && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#0b1526]/55" role="timer" aria-live="assertive" aria-label={`Recording in ${cd}`}>
                <span key={cd} className={`text-8xl font-semibold tabular-nums text-[#ffffff] drop-shadow-lg sm:text-9xl ${reducedMotion ? "" : "animate-[vi-pop_0.9s_ease-out]"}`}>
                  {cd}
                </span>
              </div>
            )}

            {m.phase === "recording" && (
              <div className="absolute left-3 top-3 inline-flex items-center gap-2 rounded-full bg-[#b42318] px-3 py-1.5 text-xs font-semibold text-[#ffffff]" role="timer" aria-live="off">
                <Circle size={9} fill="currentColor" className="animate-pulse motion-reduce:animate-none" aria-hidden />
                Recording · {clock(answerLeft(m))} left
              </div>
            )}
            {m.phase === "thinking" && cd == null && (
              <div className="absolute left-3 top-3 rounded-full bg-[#0b1526]/80 px-3 py-1.5 text-xs font-semibold text-[#ffffff]" role="timer" aria-live="off">
                Think time · {clock(m.thinkLeft)}
              </div>
            )}
            {(m.phase === "processing" || m.phase === "stopping") && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0b1526]/70 px-6 text-center" role="status">
                <Loader2 size={28} className="animate-spin text-[#ffffff] motion-reduce:animate-none" aria-hidden />
                <p className="text-sm text-[#ffffff]">{transcriptionReady ? "Transcribing and scoring your answer…" : "Saving your answer…"}</p>
              </div>
            )}
            {m.phase === "done" && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#0b1526]/60" role="status">
                <p className="rounded-full bg-[#ffffff] px-4 py-2 text-sm font-semibold text-brand-900">
                  {answer?.status === "complete" ? `Answer saved${answer.feedback?.overall != null ? ` · ${answer.feedback.overall}/100` : ""}` : "Saved on this device"}
                  {question && trainingCopy[question.id] === "kept" && " · training copy kept"}
                  {question && trainingCopy[question.id] === "failed" && " · training copy not saved"}
                  {question && trainingCopy[question.id] === "no_storage" && " · no training copy (storage isn't set up)"}
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 px-5 py-4">
            {!started && (
              <button
                type="button"
                className={PRIMARY}
                disabled={camera !== "ready"}
                onClick={() => {
                  setStarted(true);
                  ask(session, firstOpen(session));
                }}
              >
                Begin interview
              </button>
            )}
            {started && (m.phase === "asking" || m.phase === "thinking") && cd == null && (
              <button type="button" className={PRIMARY} onClick={() => dispatch({ type: "READY_NOW" })}>
                <Circle size={12} fill="currentColor" aria-hidden />
                I&apos;m ready - start the countdown
              </button>
            )}
            {m.phase === "recording" && (
              <button type="button" className={PRIMARY} disabled={m.recorded < MIN_RECORD_SECONDS} onClick={() => dispatch({ type: "FINISH" })}>
                <Square size={12} fill="currentColor" aria-hidden />
                Finish answer
              </button>
            )}
            {m.phase === "failed" && (
              <>
                {canRetry && (
                  <button type="button" className={PRIMARY} onClick={() => dispatch({ type: "RETRY" })}>
                    <RotateCcw size={14} aria-hidden />
                    Try again
                  </button>
                )}
                {answer?.status !== "complete" && (
                  <button type="button" className={canRetry ? SECONDARY : PRIMARY} onClick={() => ask(session, index)} disabled={camera !== "ready"}>
                    <RotateCcw size={14} aria-hidden />
                    Record again
                  </button>
                )}
                <button type="button" className={SECONDARY} onClick={skipCurrent} disabled={busy}>
                  <SkipForward size={14} aria-hidden />
                  Skip question
                </button>
              </>
            )}
            {started && m.phase !== "processing" && m.phase !== "stopping" && (m.phase !== "ended" || ending) && (
              <button
                type="button"
                onClick={endEarly}
                disabled={ending}
                aria-busy={ending}
                className="ml-auto inline-flex items-center gap-1.5 text-xs text-warmgray-500 hover:text-brand-900 hover:underline disabled:cursor-wait disabled:no-underline disabled:opacity-70"
              >
                {ending && <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />}
                {ending ? "Ending interview…" : "End interview"}
              </button>
            )}
            {m.phase === "ended" && !ending && endError && (
              <>
                <button type="button" className={PRIMARY} onClick={() => void showReport(session)}>
                  <RotateCcw size={14} aria-hidden />
                  Try ending again
                </button>
                {firstOpen(session) < session.questions.length && (
                  <button type="button" className={SECONDARY} onClick={resumeAfterFailedEnd} disabled={camera !== "ready"}>
                    Keep answering
                  </button>
                )}
              </>
            )}
          </div>
          {camera === "ready" && session.training.optedIn && (
            <p className="px-5 pb-3 text-xs text-warmgray-600">{cameraDisclosure}</p>
          )}
          {m.phase === "ended" && (ending || endError) && (
            <p role={endError ? "alert" : "status"} className={`px-5 pb-4 text-sm ${endError ? "text-error-600" : "text-brand-900"}`}>
              {endError ? `The interview wasn't ended: ${endError}` : "Ending interview… your answers so far are saved."}
            </p>
          )}
          {m.phase === "failed" && m.error && (
            <p role="alert" className="px-5 pb-4 text-sm text-error-600">
              {m.error}
            </p>
          )}
          {notice && <p role="status" className="px-5 pb-4 text-sm text-brand-900">{notice}</p>}
        </section>
      </div>
    </div>
  );
}
