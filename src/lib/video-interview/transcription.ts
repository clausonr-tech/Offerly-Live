import "server-only";

import type { TimedWord } from "./delivery-metrics";

/**
 * Speech-to-text for interview answers, behind one small interface so the
 * provider can change without touching the coach.
 *
 * The only implementation speaks the OpenAI-compatible
 * `POST {base}/audio/transcriptions` API, which OpenAI, Groq, Azure OpenAI,
 * and self-hosted Whisper servers (faster-whisper-server, LocalAI) all serve.
 * Configured ONLY through server environment variables - see
 * docs/VIDEO_INTERVIEW_SETUP.md. The key is read here and sent from here; no
 * route or action returns it, and nothing under src/app reads these variables.
 *
 * Unset, the provider reports itself unconfigured and the coach says so: an
 * answer is still saved and scored on what can be scored, never faked.
 */

export type TranscriptionResult = {
  text: string;
  /** Word timings in seconds, when the provider returns them. */
  words: TimedWord[] | null;
  /**
   * The audio's real length in seconds, as the PROVIDER measured it, when it
   * reports one (verbose_json does). This is the only trustworthy duration in
   * the pipeline: the browser's durationMs is a claim, and the byte cap does
   * not bound length because a low-bitrate file can be very long. The STT
   * budget and the length check both read this.
   */
  durationSeconds?: number | null;
};

export class TranscriptionUnconfiguredError extends Error {
  constructor() {
    super("Speech-to-text is not set up on this server.");
    this.name = "TranscriptionUnconfiguredError";
  }
}

/** A failure worth retrying (timeout, 429, 5xx) versus one that is not. */
export class TranscriptionError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(audio: { bytes: Buffer; contentType: string; filename: string }): Promise<TranscriptionResult>;
}

export type TranscriptionConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** "verbose_json" gives word timings (whisper-1, Groq whisper); "json" is
   *  text only (gpt-4o-transcribe). */
  responseFormat: "verbose_json" | "json";
  timeoutMs: number;
  language: string | null;
};

/** One line per process, not one per transcription. */
let warnedAboutNoDuration = false;

/** The configuration from the environment, or null when it is not set up. */
export function transcriptionConfigFromEnv(env: Record<string, string | undefined> = process.env): TranscriptionConfig | null {
  const apiKey = env.TRANSCRIPTION_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (env.TRANSCRIPTION_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  // https only, except a local server during development.
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;

  const model = env.TRANSCRIPTION_MODEL?.trim() || "whisper-1";
  const fmt = env.TRANSCRIPTION_RESPONSE_FORMAT?.trim();
  const responseFormat = fmt === "json" || fmt === "verbose_json" ? fmt : model.startsWith("gpt-4o") ? "json" : "verbose_json";
  // "json" carries no duration, and the duration is the only trustworthy bound
  // on what this provider will bill: the browser's claim is a claim, and the
  // byte cap cannot bound minutes, because a low enough bitrate puts an hour of
  // audio inside any size you care to allow. lib/video-interview/stt-budget
  // then has to charge what the bytes COULD be worth, which over-charges an
  // honest student and still under-charges a crafted file. That is a real
  // weakening of the spend ceiling, so the configuration that causes it says so
  // once rather than being a silent property of an environment variable.
  if (responseFormat === "json" && !warnedAboutNoDuration) {
    warnedAboutNoDuration = true;
    console.error(
      `[transcription] model "${model}" is configured with the "json" response format, which reports no audio duration: ` +
        "the daily budget has to charge what the file's bytes could be worth instead of what was actually transcribed. " +
        "Prefer a model that accepts verbose_json (whisper-1 does) if the speech-to-text bill matters.",
    );
  }
  const timeout = Number(env.TRANSCRIPTION_TIMEOUT_MS);
  return {
    apiKey,
    baseUrl,
    model,
    responseFormat,
    timeoutMs: Number.isFinite(timeout) && timeout >= 5_000 && timeout <= 120_000 ? timeout : 45_000,
    language: env.TRANSCRIPTION_LANGUAGE?.trim() || "en",
  };
}

// Whisper drops fillers unless the prompt shows them - a known quirk. Priming
// it with disfluent text is what makes "um" and "like" survive transcription,
// which the filler count depends on.
const VERBATIM_PROMPT = "Umm, so, uh, I think, like, the the main thing was... you know, hmm, basically we, uh, decided to";

export class OpenAICompatibleTranscriber implements TranscriptionProvider {
  readonly name = "openai-compatible";
  constructor(private readonly config: TranscriptionConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async transcribe(audio: { bytes: Buffer; contentType: string; filename: string }): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio.bytes)], { type: audio.contentType }), audio.filename);
    form.append("model", this.config.model);
    form.append("response_format", this.config.responseFormat);
    if (this.config.language) form.append("language", this.config.language);
    form.append("prompt", VERBATIM_PROMPT);
    if (this.config.responseFormat === "verbose_json") {
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      const timeout = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
      throw new TranscriptionError(timeout ? "Transcription timed out." : "Couldn't reach the transcription service.", true);
    }

    if (!res.ok) {
      // The body can echo request details; it is never passed on.
      const retryable = res.status === 429 || res.status >= 500;
      throw new TranscriptionError(`Transcription failed (HTTP ${res.status}).`, retryable);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TranscriptionError("The transcription service sent an unreadable reply.", true);
    }
    return parseTranscriptionBody(body);
  }
}

/** Validates a provider reply rather than trusting its shape. */
export function parseTranscriptionBody(body: unknown): TranscriptionResult {
  if (!body || typeof body !== "object") throw new TranscriptionError("Empty transcription reply.", true);
  const b = body as { text?: unknown; words?: unknown; duration?: unknown };
  if (typeof b.text !== "string") throw new TranscriptionError("Transcription reply had no text.", true);
  let words: TimedWord[] | null = null;
  if (Array.isArray(b.words)) {
    words = b.words
      .filter(
        (w): w is { word: string; start: number; end: number } =>
          !!w &&
          typeof (w as TimedWord).word === "string" &&
          typeof (w as TimedWord).start === "number" &&
          typeof (w as TimedWord).end === "number",
      )
      .slice(0, 5000)
      .map((w) => ({ word: w.word.slice(0, 64), start: w.start, end: w.end }));
    if (words.length === 0) words = null;
  }
  // Providers report `duration` in seconds on verbose_json. Anything that is
  // not a sane positive number is treated as "not reported" rather than zero.
  const reported = typeof b.duration === "number" && Number.isFinite(b.duration) && b.duration > 0 ? b.duration : null;
  return { text: b.text.slice(0, 20_000).trim(), words, durationSeconds: reported };
}

let override: TranscriptionProvider | null | undefined;

/** Tests swap the provider in; production never calls this. */
export function setTranscriptionProviderForTests(p: TranscriptionProvider | null | undefined): void {
  override = p;
}

/** The configured provider, or null when speech-to-text is not set up. */
export function getTranscriptionProvider(): TranscriptionProvider | null {
  if (override !== undefined) return override;
  const config = transcriptionConfigFromEnv();
  return config ? new OpenAICompatibleTranscriber(config) : null;
}

export function isTranscriptionConfigured(): boolean {
  return getTranscriptionProvider() !== null;
}
