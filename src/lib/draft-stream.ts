// Watching the draft being written, instead of watching a spinner.
//
// The draft call is a structured output: one text content block whose text is a
// JSON document matching `draftOutputSchema` (lib/draft-pipeline). The SDK
// delivers that block as ordinary `text_delta` events - structured output is a
// text block, and `parseMessage` simply runs the Zod parse over `block.text`
// once the block closes (node_modules/@anthropic-ai/sdk/lib/parser.js). So the
// JSON arrives character by character, and nothing in the SDK hands back a
// partially-parsed object: `inputJson` fires only for tool_use blocks
// (`tracksToolInput`, lib/MessageStream.js). Pulling `body` out as it fills is
// therefore ours to do, and this module is all of it.
//
// Three pieces:
//   - TopLevelJsonScanner: reads the top-level keys of a JSON object out of a
//     growing string, emitting each string value's characters as they arrive.
//   - createTextGate: decides how much of that text may be shown to the
//     student yet, and refuses to show any of it once the accumulated text
//     contains blocked language.
//   - streamWith / streamDraftCall: the stream twin of `parseWith`, and the
//     loop that turns deltas into PipelineEvents.
//
// Pure except for the SDK call in streamDraftCall, and deliberately not
// "server-only": scripts/draft-stream-test.ts drives all of it directly.

import type Anthropic from "@anthropic-ai/sdk";
import { findBlockedLanguage, type BlockedKind } from "./content-limits";
import type { ReviewProblem } from "./draft-review";

/**
 * What the pipeline reports as it goes, when it is given an `onEvent`.
 *
 * Everything here is PROVISIONAL except `final`. The text in `plan`,
 * `subject` and `body-delta` is what the drafting model wrote; it has not been
 * through the review pass, the deterministic fixes or the database. The student
 * is told that in as many words (DraftStreamPreview) and cannot edit or send it.
 */
export type PipelineEvent =
  /** The model's outline of the email it is about to write, in order. */
  | { type: "plan"; people: { name: string; role: string }[]; sentences: string[] }
  | { type: "subject"; subject: string }
  /** More of the provisional body. Already past the blocked-language gate below. */
  | { type: "body-delta"; text: string }
  /** The drafting model has finished and the deterministic fixes have run. The review has not. */
  | { type: "draft-finished"; subject: string; body: string }
  | { type: "review-started" }
  | { type: "review-finished"; applied: boolean; problems: ReviewProblem[] }
  | { type: "review-skipped"; reason: string };

// ---------------------------------------------------------------------------
// Reading JSON that hasn't finished arriving
// ---------------------------------------------------------------------------

export type ScanEvent =
  /** More characters of a top-level string value, already unescaped. */
  | { type: "string-delta"; key: string; text: string }
  /** A top-level string value closed. `text` is the whole value. */
  | { type: "string-done"; key: string; text: string }
  /** A top-level object, array or scalar value closed. `raw` is its exact JSON text. */
  | { type: "value"; key: string; raw: string };

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Unescape a JSON string value from `at` as far as the buffer safely allows.
 *
 * Stops short rather than guessing: a trailing `\` or a half-written `é`
 * leaves `next` pointing at the backslash, so the next call re-reads it once
 * the rest has arrived. That is the whole reason this is a function and not a
 * regex - an escape can be split across two deltas.
 */
export function decodeStringFrom(buf: string, at: number): { text: string; next: number; done: boolean } {
  let out = "";
  let i = at;
  while (i < buf.length) {
    const c = buf[i];
    if (c === '"') return { text: out, next: i + 1, done: true };
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    const esc = buf[i + 1];
    if (esc === undefined) break;
    if (esc === "u") {
      const hex = buf.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    if (!(esc in ESCAPES)) break;
    out += ESCAPES[esc];
    i += 2;
  }
  return { text: out, next: i, done: false };
}

type Mode = "pre" | "key" | "colon" | "value" | "string" | "nested" | "scalar" | "done";

/**
 * The top-level keys of one JSON object, read out of a string that is still
 * growing.
 *
 * Only the top level is interpreted. A nested object or array is captured
 * whole, as raw JSON, so the caller can `JSON.parse` it once it closes - which
 * is what `plan` needs. Nothing is guessed: when the buffer runs out mid-token
 * the scanner stops and resumes from the same place on the next `push`.
 *
 * Why not search for `"body":` in the accumulated text: `body` can appear
 * inside an earlier string value (a plan sentence may say the word), and a
 * substring search cannot tell a key from the inside of a string. This walks
 * the document, so it can.
 */
export class TopLevelJsonScanner {
  private buf = "";
  private i = 0;
  private mode: Mode = "pre";
  private key = "";
  private decoded = "";
  private valueStart = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;

  /** Whether the object closed, or the text turned out not to be one. */
  get finished(): boolean {
    return this.mode === "done";
  }

  push(chunk: string): ScanEvent[] {
    this.buf += chunk;
    const out: ScanEvent[] = [];
    for (;;) {
      switch (this.mode) {
        case "pre": {
          if (!this.skipSpace()) return out;
          if (this.buf[this.i] !== "{") return this.give_up(out);
          this.i++;
          this.mode = "key";
          break;
        }
        case "key": {
          if (!this.skipSpace()) return out;
          const c = this.buf[this.i];
          if (c === "}") {
            this.mode = "done";
            return out;
          }
          if (c === ",") {
            this.i++;
            break;
          }
          if (c !== '"') return this.give_up(out);
          // Keys are short and never shown to anyone, so waiting for the whole
          // key is simpler than streaming it.
          const read = decodeStringFrom(this.buf, this.i + 1);
          if (!read.done) return out;
          this.key = read.text;
          this.i = read.next;
          this.mode = "colon";
          break;
        }
        case "colon": {
          if (!this.skipSpace()) return out;
          if (this.buf[this.i] !== ":") return this.give_up(out);
          this.i++;
          this.mode = "value";
          break;
        }
        case "value": {
          if (!this.skipSpace()) return out;
          const c = this.buf[this.i];
          if (c === '"') {
            this.i++;
            this.decoded = "";
            this.mode = "string";
            break;
          }
          this.valueStart = this.i;
          if (c === "{" || c === "[") {
            this.depth = 0;
            this.inString = false;
            this.escaped = false;
            this.mode = "nested";
            break;
          }
          this.mode = "scalar";
          break;
        }
        case "string": {
          const read = decodeStringFrom(this.buf, this.i);
          this.i = read.next;
          if (read.text) {
            this.decoded += read.text;
            out.push({ type: "string-delta", key: this.key, text: read.text });
          }
          if (!read.done) return out;
          out.push({ type: "string-done", key: this.key, text: this.decoded });
          this.mode = "key";
          break;
        }
        case "nested": {
          while (this.i < this.buf.length) {
            const c = this.buf[this.i++];
            if (this.inString) {
              if (this.escaped) this.escaped = false;
              else if (c === "\\") this.escaped = true;
              else if (c === '"') this.inString = false;
              continue;
            }
            if (c === '"') {
              this.inString = true;
              continue;
            }
            if (c === "{" || c === "[") this.depth++;
            else if (c === "}" || c === "]") {
              this.depth--;
              if (this.depth === 0) {
                out.push({ type: "value", key: this.key, raw: this.buf.slice(this.valueStart, this.i) });
                this.mode = "key";
                break;
              }
            }
          }
          if (this.mode === "nested") return out;
          break;
        }
        case "scalar": {
          let j = this.i;
          while (j < this.buf.length && this.buf[j] !== "," && this.buf[j] !== "}") j++;
          // Stop short of the end: "nul" is not "null" yet.
          if (j >= this.buf.length) return out;
          out.push({ type: "value", key: this.key, raw: this.buf.slice(this.valueStart, j).trim() });
          this.i = j;
          this.mode = "key";
          break;
        }
        case "done":
          return out;
      }
    }
  }

  private skipSpace(): boolean {
    while (this.i < this.buf.length && /\s/.test(this.buf[this.i])) this.i++;
    return this.i < this.buf.length;
  }

  // Not valid JSON at the top level. Stop reading rather than throw: the
  // authoritative parse is the SDK's, on the finished message, and it will say
  // so far better than a half-read stream can.
  private give_up(out: ScanEvent[]): ScanEvent[] {
    this.mode = "done";
    return out;
  }
}

// ---------------------------------------------------------------------------
// Deciding how much may be shown
// ---------------------------------------------------------------------------

/**
 * The length of the trailing region of `text` whose meaning can still change
 * when more characters arrive.
 *
 * `findBlockedLanguage` matches whole words (`\b`), and before matching it
 * undoes the usual disguises - including joining letters that are spaced or
 * dotted apart, so `f u c k` reads as one word (lib/content-limits,
 * `readings`). Both facts cross a delta boundary: a word is only decidable
 * once it has ended, and a run of single letters is only decidable once the
 * run has ended. So the tail held back is the word in progress plus any run of
 * separated single letters immediately before it.
 *
 * Everything in front of that tail has been seen by the check in its final
 * form, which is what makes releasing it safe.
 */
export function unsettledTailLength(text: string): number {
  // The word still being written.
  const word = /\S*$/.exec(text)?.[0].length ?? 0;
  // A trailing run of separated single letters. Two or more, because that is
  // what content-limits joins: `(?:[a-z][\s.\-_]+){2,}[a-z]` - three letters
  // at the least, so "you well" is not a disguise and "s.h.i" is. The \b is
  // content-limits' own: it will not join a run starting mid-word.
  const spaced = /\b(?:[A-Za-z][\s.\-_]+){2,}\S*$/.exec(text)?.[0].length ?? 0;
  return Math.max(word, spaced);
}

export type GateRelease = { text: string } | { blocked: BlockedKind };

/**
 * The gate every character of model text passes before the student sees it.
 *
 * Two rules, and together they are what makes a release safe:
 *  1. Only text in front of `unsettledTailLength` is ever released, so a word
 *     that is three characters into becoming a slur is never on screen: it is
 *     still in the tail when the check reaches it.
 *  2. `findBlockedLanguage` runs over exactly that releasable prefix, on every
 *     push, before any of it goes out. So every prefix ever released was
 *     checked clean in the form it was released in - releases are monotone
 *     prefixes of text that was clean at the moment of release. `flush` checks
 *     the whole buffer, because once the value has ended nothing is unsettled.
 *
 * The prefix, not the whole buffer, is deliberate and it is a correctness
 * requirement, not an optimisation: `findBlockedLanguage` counts the end of
 * the string it is handed as a word boundary, so checking the half-arrived
 * tail as well reads "Associate" as "ass" and "cocktail" as "cock" and throws
 * a clean draft away. A blocked word inside the tail is caught one push later,
 * when the word ends - and it was never releasable in the meantime.
 *
 * On a hit the gate latches shut. The caller aborts the upstream stream and
 * fails the request with the same message the finished draft would have failed
 * with - the student never sees a partial email that was about to be rejected.
 */
export function createTextGate() {
  let buffer = "";
  let released = 0;
  let blocked: BlockedKind | null = null;

  /**
   * Latch shut if the first `upTo` characters contain blocked language.
   *
   * Bounded rather than run over the whole buffer, because the unsettled tail
   * ends mid-word and `findBlockedLanguage` treats the end of the string it is
   * given as a word boundary. Checking the tail too would read a half-arrived
   * "Associate" as the whole word "ass" and reject a clean draft - see the
   * split-delta cases in scripts/draft-stream-test.ts.
   */
  const check = (upTo: number): BlockedKind | null => {
    if (blocked) return blocked;
    const kind = findBlockedLanguage(buffer.slice(0, upTo));
    if (kind) blocked = kind;
    return blocked;
  };

  return {
    /** Everything accumulated so far, released or not. */
    get text() {
      return buffer;
    },
    get blocked() {
      return blocked;
    },
    /** Add `text`, then release whatever is now safe to show. */
    push(text: string): GateRelease {
      if (blocked) return { blocked };
      buffer += text;
      // Exactly the text that may be released is the text that is checked:
      // everything in front of the unsettled tail, which ends at a word
      // boundary and outside any run of separated single letters.
      const safe = buffer.length - unsettledTailLength(buffer);
      const kind = check(safe);
      if (kind) return { blocked: kind };
      if (safe <= released) return { text: "" };
      const out = buffer.slice(released, safe);
      released = safe;
      return { text: out };
    },
    /** The value is complete: release the held-back tail too. */
    flush(): GateRelease {
      if (blocked) return { blocked };
      // Nothing is unsettled any more - the last word has ended because the
      // value has - so the whole buffer is checked before the tail goes out.
      const kind = check(buffer.length);
      if (kind) return { blocked: kind };
      const out = buffer.slice(released);
      released = buffer.length;
      return { text: out };
    },
  };
}

/** One whole string, checked before anyone sees it. Used for the subject and the plan. */
export function gateWhole(text: string): GateRelease {
  const kind = findBlockedLanguage(text);
  return kind ? { blocked: kind } : { text };
}

/** The message a blocked stream fails with - the same one the finished draft fails with. */
export const BLOCKED_DRAFT_MESSAGE = "The draft came back with language we don't allow. Please try again.";

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

// The same beta the non-streaming fast path uses. Declared here rather than
// imported because lib/fast-mode does not export it; the two must stay equal.
const FAST_MODE_BETA = "fast-mode-2026-02-01";

/** What the pipeline needs back from a finished stream - the same fields it reads off `parse`. */
export type StreamedMessage<T> = {
  stop_reason: string | null;
  usage: { input_tokens?: number | null; output_tokens?: number | null };
  parsed_output: T | null;
};

type MinimalStream<T> = {
  on(event: "text", listener: (delta: string, snapshot: string) => void): unknown;
  finalMessage(): Promise<StreamedMessage<T>>;
  abort(): void;
};

/**
 * The `stream` to call for a config: the beta endpoint with `speed: "fast"`
 * when the config asks for it, the stable endpoint otherwise - exactly the
 * shape `parseWith` (lib/fast-mode) gives the non-streaming path.
 *
 * Fast mode and streaming are NOT mutually exclusive. `speed` and
 * `output_config` both sit on the beta endpoint's `MessageCreateParamsBase`,
 * `BetaMessageStream.createMessage` posts `{...params, stream: true}` to it,
 * and `BetaMessageStream.finalMessage` runs `maybeParseBetaMessage` over the
 * stored params - so `parsed_output` comes back from a streamed fast-mode call
 * the same way it comes back from `parse`
 * (node_modules/@anthropic-ai/sdk/lib/BetaMessageStream.js:114, :447).
 *
 * The one cast: `BetaMessageStreamParams` is the plain `MessageCreateParamsBase`
 * rather than the parseable variant, so TypeScript infers `ParsedT = null` on
 * the beta path even though the runtime parses. The stable path infers properly.
 */
export function streamWith<T>(
  client: Anthropic,
  cfg: { speed?: "fast" | null },
): (params: Record<string, unknown>) => MinimalStream<T> {
  if (cfg.speed !== "fast") {
    return (params) => client.messages.stream(params as never) as unknown as MinimalStream<T>;
  }
  return (params) =>
    client.beta.messages.stream({
      ...params,
      speed: "fast",
      betas: [FAST_MODE_BETA],
    } as never) as unknown as MinimalStream<T>;
}

/** The shape streamDraftCall reports on; a subset of `draftOutputSchema`. */
type StreamablePlan = { people: { name: string; role: string }[]; sentences: string[] };

/**
 * Every word of a plan that the student will read, as one string for the
 * blocked-language check. `String()` because a half-written model reply is not
 * the schema yet - the authoritative parse is the SDK's, on the finished
 * message, and until then a `people` entry may be anything at all.
 */
function planText(plan: StreamablePlan): string {
  return [
    ...plan.sentences.map((s) => String(s ?? "")),
    ...plan.people.flatMap((p) => [String(p?.name ?? ""), String(p?.role ?? "")]),
  ].join("\n");
}

/**
 * The draft call, streamed, reporting `plan`, `subject` and the body as they
 * arrive and handing back the finished parsed message.
 *
 * The parsed message is still the SDK's own - the stream is only a view of the
 * text on its way past. Every gate in runDraftPipeline runs on the parsed
 * result afterwards exactly as it does on the non-streaming path, which is why
 * this cannot weaken the email that gets saved.
 */
export async function streamDraftCall<T>(
  client: Anthropic,
  cfg: { speed?: "fast" | null },
  params: Record<string, unknown>,
  onEvent: (event: PipelineEvent) => void,
): Promise<StreamedMessage<T>> {
  const stream = streamWith<T>(client, cfg)(params);
  const scanner = new TopLevelJsonScanner();
  const body = createTextGate();
  let blocked: BlockedKind | null = null;

  const fail = (kind: BlockedKind) => {
    if (blocked) return;
    blocked = kind;
    // Never logged with the text, the same as every other blocked-language path.
    console.error(`[draft-stream] blocked language mid-stream (${kind}); stream aborted`);
    stream.abort();
  };

  stream.on("text", (delta) => {
    if (blocked) return;
    for (const event of scanner.push(delta)) {
      if (blocked) return;
      if (event.type === "value" && event.key === "plan") {
        let plan: StreamablePlan | null = null;
        try {
          const read = JSON.parse(event.raw) as StreamablePlan;
          if (Array.isArray(read?.people) && Array.isArray(read?.sentences)) plan = read;
        } catch {
          // A plan we cannot read is only a lost progress indicator. The
          // authoritative parse is the SDK's, on the finished message.
        }
        if (!plan) continue;
        // Checked on the decoded strings, not on `event.raw`: a JSON `\u`
        // escape reaches the student as the character it stands for, so the
        // decoded text is the only form of it the check can be asked about.
        // Parsed first for the same reason - the raw document is not what
        // anyone reads.
        const checked = gateWhole(planText(plan));
        if ("blocked" in checked) return fail(checked.blocked);
        onEvent({ type: "plan", people: plan.people, sentences: plan.sentences });
        continue;
      }
      if (event.type === "string-done" && event.key === "subject") {
        const checked = gateWhole(event.text);
        if ("blocked" in checked) return fail(checked.blocked);
        onEvent({ type: "subject", subject: checked.text });
        continue;
      }
      if (event.key === "body" && (event.type === "string-delta" || event.type === "string-done")) {
        const out = event.type === "string-delta" ? body.push(event.text) : body.flush();
        if ("blocked" in out) return fail(out.blocked);
        if (out.text) onEvent({ type: "body-delta", text: out.text });
      }
    }
  });

  const finished = await stream.finalMessage().catch((err: unknown) => {
    // An abort we asked for: report the real reason, not "aborted".
    if (blocked) throw new Error(BLOCKED_DRAFT_MESSAGE);
    throw err;
  });
  if (blocked) throw new Error(BLOCKED_DRAFT_MESSAGE);
  return finished;
}
