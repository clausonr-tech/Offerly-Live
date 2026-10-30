import { ALLOWED_AUDIO_TYPES, DURATION_GRACE_MS, MAX_AUDIO_BYTES, MAX_AUDIO_BYTES_PER_SECOND, MIN_ANSWER_MS } from "./types";

/**
 * What an uploaded answer must be before anything reads it: an allowed audio
 * type whose bytes actually are that type, inside the size cap, and a duration
 * the interview allows - which is also checked against the server's own clock,
 * so a client cannot claim a two-minute answer to a question served ten
 * seconds ago.
 *
 * Pure, and cheapest check first: a request can carry megabytes.
 */

export type UploadCheck =
  | { ok: true; contentType: (typeof ALLOWED_AUDIO_TYPES)[number]; extension: string }
  | { ok: false; error: string };

/** "audio/webm;codecs=opus" -> "audio/webm". */
export function baseMimeType(type: string): string {
  return type.split(";")[0].trim().toLowerCase();
}

/** The container the bytes really are, from their first bytes. */
export function sniffAudioContainer(head: Uint8Array): "webm" | "ogg" | "mp4" | "mpeg" | "wav" | null {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "webm";
  if (head.length >= 4 && head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) return "ogg";
  if (head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return "mp4";
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45) return "wav";
  if (head.length >= 3 && ((head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0))) return "mpeg";
  return null;
}

const CONTAINER_TYPE = {
  webm: "audio/webm",
  ogg: "audio/ogg",
  mp4: "audio/mp4",
  mpeg: "audio/mpeg",
  wav: "audio/wav",
} as const;

export function validateAudioUpload(input: {
  declaredType: string;
  size: number;
  head: Uint8Array;
  durationMs: number;
  answerSeconds: number;
  /** Milliseconds since the server served this question. */
  msSinceServed: number;
}): UploadCheck {
  if (!Number.isFinite(input.size) || input.size <= 0) return { ok: false, error: "The recording was empty. Try that answer again." };
  if (input.size > MAX_AUDIO_BYTES) return { ok: false, error: "That recording is too large to upload." };
  // Bounded against the answer time the question allowed, not just the flat
  // ceiling. The checks below bound the CLAIMED duration from above but never
  // from below, so under-reporting was free: a 4MB low-bitrate file declared as
  // three seconds is an hour of audio the provider bills for. Weight is the one
  // thing here the client cannot lie about.
  // Math.min, because the two ceilings crossed over: at the longest answer
  // option (180s) the per-second cap works out above the flat MAX_AUDIO_BYTES,
  // so the per-second rule stopped binding at exactly the length an attacker
  // would choose. Whichever is tighter applies.
  const weightCap = Math.min(
    MAX_AUDIO_BYTES,
    Math.ceil((input.answerSeconds + DURATION_GRACE_MS / 1000) * MAX_AUDIO_BYTES_PER_SECOND),
  );
  if (input.size > weightCap) {
    return { ok: false, error: "That recording is too large for an answer of this length." };
  }

  const declared = baseMimeType(input.declaredType);
  // Browsers label an audio-only WebM as video/webm now and then; accept the
  // label, but the bytes decide what it is stored and sent as.
  const declaredOk = (ALLOWED_AUDIO_TYPES as readonly string[]).includes(declared) || declared === "video/webm" || declared === "video/mp4";
  if (!declaredOk) return { ok: false, error: "That recording format isn't supported." };

  const container = sniffAudioContainer(input.head);
  if (!container) return { ok: false, error: "That file isn't a recording this coach can read." };
  if (!declared.endsWith(container === "mpeg" ? "mpeg" : container)) {
    return { ok: false, error: "The recording's format didn't match its contents." };
  }

  const d = input.durationMs;
  if (!Number.isFinite(d) || d < MIN_ANSWER_MS) return { ok: false, error: "That answer was too short to score. Try it again." };
  const max = input.answerSeconds * 1000 + DURATION_GRACE_MS;
  if (d > max) return { ok: false, error: "That recording is longer than the answer time allows." };
  // The answer cannot be longer than the time since the question was served.
  if (d > input.msSinceServed + DURATION_GRACE_MS) return { ok: false, error: "That recording's length doesn't add up. Try the answer again." };

  return { ok: true, contentType: CONTAINER_TYPE[container], extension: container === "mpeg" ? "mp3" : container === "mp4" ? "m4a" : container };
}
