// The streaming draft's two load-bearing pieces, tested without a server, a
// database or the API:
//
//   1. TopLevelJsonScanner  - pulls `plan`, `subject` and `body` out of a JSON
//      document that is still arriving, one delta at a time.
//   2. createTextGate       - decides how much of the body may be shown yet,
//      and latches shut the moment the accumulated text contains blocked
//      language (lib/content-limits).
//   3. applyFrame/previewView - the client state machine: what the student is
//      shown after any sequence of frames, including the ones a browser is
//      hard to make happen on purpose (blocked halfway, connection dies, the
//      review rewrites text already on screen).
//
// Plus streamDraftCall end to end against a stub stream that emits deltas, so
// the gate's abort path is exercised rather than argued about.
//
//   npx tsx scripts/draft-stream-test.ts

import type Anthropic from "@anthropic-ai/sdk";
import {
  BLOCKED_DRAFT_MESSAGE,
  TopLevelJsonScanner,
  createTextGate,
  decodeStringFrom,
  streamDraftCall,
  unsettledTailLength,
  type PipelineEvent,
  type ScanEvent,
} from "../src/lib/draft-stream";
import { findBlockedLanguage, type BlockedKind } from "../src/lib/content-limits";
import {
  DEAD_STREAM,
  IDLE_STREAM_STATE,
  applyFrame,
  canStream,
  draftArrived,
  previewView,
  type DraftStreamFrame,
  type DraftStreamState,
  type PreviewView,
} from "../src/app/(app)/drafts/draft-stream-view";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
  } else {
    fail++;
    console.error(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  }
}

/** Feed `text` through a scanner in chunks of `size`, collecting every event. */
function scanInChunks(text: string, size: number): ScanEvent[] {
  const scanner = new TopLevelJsonScanner();
  const out: ScanEvent[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...scanner.push(text.slice(i, i + size)));
  return out;
}

const DRAFT = {
  plan: {
    people: [
      { name: "Rachel Stein", role: "the recipient, whom the student met at the panel" },
      { name: "Emily Tran", role: "the student's club president, who referred them" },
    ],
    sentences: ["Thank her for the panel.", 'Say Emily Tran sent me - note the word "body" here.', "Ask for 15 minutes."],
  },
  subject: "Referred by Emily Tran",
  body: "Hi Rachel,\n\nEmily Tran suggested I reach out.\n\nBest,\nMaya",
  connectionUsed: null,
  gaps: [{ placeholder: "[your availability]", question: "When are you free?" }],
  notesForStudent: ["Attach your resume."],
};
const JSON_TEXT = JSON.stringify(DRAFT);

// ---------------------------------------------------------------------------
console.log("decodeStringFrom");
// ---------------------------------------------------------------------------
{
  const whole = decodeStringFrom('hello"rest', 0);
  t("reads a complete string", whole.done && whole.text === "hello" && whole.next === 6, whole);

  const partial = decodeStringFrom("hel", 0);
  t("stops at the end of the buffer", !partial.done && partial.text === "hel" && partial.next === 3, partial);

  const escaped = decodeStringFrom('a\\nb\\"c"', 0);
  t("unescapes \\n and \\\"", escaped.done && escaped.text === 'a\nb"c', escaped);

  // A half-written escape must not be guessed at: next points back at the "\".
  const halfEscape = decodeStringFrom("ab\\", 0);
  t("holds back a trailing backslash", !halfEscape.done && halfEscape.text === "ab" && halfEscape.next === 2, halfEscape);

  const halfUnicode = decodeStringFrom("ab\\u00", 0);
  t("holds back a half-written \\u escape", !halfUnicode.done && halfUnicode.text === "ab" && halfUnicode.next === 2, halfUnicode);

  const unicode = decodeStringFrom('caf\\u00e9"', 0);
  t("decodes a complete \\u escape", unicode.done && unicode.text === "café", unicode);
}

// ---------------------------------------------------------------------------
console.log("TopLevelJsonScanner");
// ---------------------------------------------------------------------------
{
  // Every chunk size from one character to the whole document at once: the
  // scanner must land on the same values however the deltas happen to split.
  for (const size of [1, 2, 3, 7, 13, 64, 500, JSON_TEXT.length]) {
    const events = scanInChunks(JSON_TEXT, size);
    const plan = events.find((e) => e.type === "value" && e.key === "plan");
    const subject = events.find((e) => e.type === "string-done" && e.key === "subject");
    const bodyDone = events.find((e) => e.type === "string-done" && e.key === "body");
    const bodyDeltas = events.filter((e) => e.type === "string-delta" && e.key === "body");

    t(
      `chunk ${size}: plan comes back as parseable raw JSON`,
      plan?.type === "value" && JSON.stringify(JSON.parse(plan.raw)) === JSON.stringify(DRAFT.plan),
      plan,
    );
    t(`chunk ${size}: subject is exact`, subject?.type === "string-done" && subject.text === DRAFT.subject, subject);
    t(`chunk ${size}: body is exact`, bodyDone?.type === "string-done" && bodyDone.text === DRAFT.body, bodyDone);
    t(
      `chunk ${size}: body deltas concatenate to the body`,
      bodyDeltas.map((e) => (e.type === "string-delta" ? e.text : "")).join("") === DRAFT.body,
    );
    // The point of walking the document instead of searching it: the word
    // "body" sits inside a plan sentence, and must not be mistaken for the key.
    const bodyKeyed = events.filter((e) => e.key === "body");
    t(`chunk ${size}: the word "body" inside a value is not read as the key`, bodyKeyed.length === bodyDeltas.length + 1);
  }

  // Order: the schema puts plan before subject before body on purpose.
  const order = scanInChunks(JSON_TEXT, 5)
    .filter((e) => e.type !== "string-delta")
    .map((e) => e.key);
  t("keys arrive in schema order", JSON.stringify(order.slice(0, 3)) === JSON.stringify(["plan", "subject", "body"]), order);

  // Nothing is emitted for a value that has not closed.
  const open = new TopLevelJsonScanner();
  const partial = open.push('{"plan":{"people":[{"name":"Rachel"');
  t("an unfinished nested value emits nothing", partial.length === 0, partial);
  t("an unfinished document is not finished", !open.finished);
  const rest = open.push('}],"sentences":[]},"subject":"Hi"');
  t("the nested value lands once it closes", rest.some((e) => e.type === "value" && e.key === "plan"), rest);
  t("a string closes on its own quote", rest.some((e) => e.type === "string-done" && e.key === "subject"));

  // Scalars, including the nullable one in the real schema.
  const scalars = scanInChunks('{"connectionUsed":null,"n":12,"ok":true}', 3).filter((e) => e.type === "value");
  t(
    "scalar values are read whole",
    JSON.stringify(scalars.map((e) => (e.type === "value" ? [e.key, e.raw] : []))) ===
      JSON.stringify([["connectionUsed", "null"], ["n", "12"], ["ok", "true"]]),
    scalars,
  );

  // Text that is not a JSON object stops the scanner instead of throwing.
  const notJson = new TopLevelJsonScanner();
  t("non-object text is given up on quietly", notJson.push("I'm sorry, I can't do that.").length === 0);
  t("giving up marks the scanner finished", notJson.finished);

  const closes = new TopLevelJsonScanner();
  closes.push('{"subject":"Hi"}');
  t("a closed object is finished", closes.finished);
}

// ---------------------------------------------------------------------------
console.log("unsettledTailLength");
// ---------------------------------------------------------------------------
{
  t("holds back the word in progress", unsettledTailLength("I hope this finds you wel") === 3, unsettledTailLength("I hope this finds you wel"));
  t("holds back nothing after a space", unsettledTailLength("I hope this finds you well ") === 0);
  t("holds back a run of separated single letters", unsettledTailLength("Hello f u c ") === 6, unsettledTailLength("Hello f u c "));
  t("holds back a dotted run", unsettledTailLength("Hello s.h.i") === 5, unsettledTailLength("Hello s.h.i"));
  t("an empty buffer holds back nothing", unsettledTailLength("") === 0);
}

// ---------------------------------------------------------------------------
console.log("createTextGate");
// ---------------------------------------------------------------------------
{
  // Clean text: everything except the tail is released, and the tail follows.
  const gate = createTextGate();
  const a = gate.push("Hi Rachel, thank you for the pan");
  t("clean text releases up to the last settled word", "text" in a && a.text === "Hi Rachel, thank you for the ", a);
  const b = gate.push("el yesterday.");
  t("the rest follows once the word ends", "text" in b && b.text === "panel ", b);
  const c = gate.flush();
  t("flush releases the word still in progress", "text" in c && c.text === "yesterday.", c);
  t("the gate's text is everything pushed", gate.text === "Hi Rachel, thank you for the panel yesterday.");
  t("a clean gate never latched", gate.blocked === null);

  // Profanity split across two deltas: never released, and the gate latches.
  const split = createTextGate();
  const first = split.push("This is a complete sh");
  t("a word in progress is not released", "text" in first && first.text === "This is a complete ", first);
  const second = split.push("itshow of an email");
  t("the completed profanity blocks instead of releasing", "blocked" in second && second.blocked === "profanity", second);
  t("the gate stays shut", "blocked" in split.push(" and more text"));
  t("flush on a shut gate stays shut", "blocked" in split.flush());

  /**
   * Drive a gate one character at a time, the way the smallest possible
   * deltas would, and report what it latched on and what it let out.
   *
   * `flush` at the end because that is what `streamDraftCall` does when the
   * JSON string closes: a word ending the value settles there and nowhere
   * else, so a gate that has not been flushed has not been asked its final
   * answer.
   */
  const drive = (text: string) => {
    const gate = createTextGate();
    const seen: string[] = [];
    for (const ch of text) {
      const r = gate.push(ch);
      if ("blocked" in r) return { blocked: r.blocked, released: seen.join("") };
      seen.push(r.text);
    }
    const end = gate.flush();
    if ("blocked" in end) return { blocked: end.blocked, released: seen.join("") };
    seen.push(end.text);
    return { blocked: null as BlockedKind | null, released: seen.join("") };
  };

  // A slur assembled one character at a time. Nothing is released past the
  // point where the releasable text is still clean.
  const perChar = drive("Dear hiring manager, you retard.");
  t("a slur typed one character at a time latches the gate", perChar.blocked === "hateful", perChar);
  t("the released text is clean", perChar.released === "Dear hiring manager, you ", perChar.released);

  // The same slur with the email carrying on after it: the word settles
  // mid-stream, so the gate latches mid-stream rather than waiting for the end.
  const midStream = drive("Dear hiring manager, you retard. Thanks.");
  t("a slur mid-body latches before the value ends", midStream.blocked === "hateful", midStream);
  t("nothing past the clean prefix was released", midStream.released === "Dear hiring manager, you ", midStream.released);

  // The disguise content-limits undoes across whitespace.
  const spaced = drive("well that is f u c k");
  t("letters spaced apart are caught", spaced.blocked === "profanity", spaced);
  t("the separated run itself was never released", !spaced.released.includes("f u"), spaced.released);

  // Words a list must not fire on, released in full.
  const safe = createTextGate();
  safe.push("Scunthorpe assessment cocktail Pakistan fire retardant analysis");
  const safeFlush = safe.flush();
  t("Scunthorpe and friends pass", "text" in safeFlush && safe.blocked === null, safeFlush);

  // The same words, split at the character where the half-arrived word reads
  // as a blocked one. A model's tokens land where they land, and the gate is
  // asked its question after every delta, so each of these is a live outcome
  // and not a hypothetical. Every one of them must pass: content-limits
  // matches whole words, and a word that has not finished arriving is not yet
  // a word. Blocking here would reject a clean draft and spend the student's
  // monthly allowance telling them their own email broke the rules.
  const SPLITS: [name: string, deltas: string[]][] = [
    ["Associate", ["your work as an ass", "ociate at Goldman."]],
    ["assessment", ["I took the ass", "essment last week."]],
    ["assets", ["the ass", "ets you cover."]],
    ["cocktail", ["at the cock", "tail reception."]],
    ["Pakistan", ["grew up in Paki", "stan before college."]],
    ["fire retardant", ["fire retard", "ant materials research."]],
    ["Scunthorpe", ["from Scun", "thorpe, England."]],
    ["classic", ["a cl", "ass", "ic banking path."]],
    ["passion", ["my p", "ass", "ion for markets."]],
    // One character at a time is the worst case of all: every prefix of every
    // word is presented to the gate on its own.
    ["all of them, one character at a time", "Associate assessment assets cocktail Pakistan fire retardant Scunthorpe classic passion".split("")],
  ];
  for (const [name, deltas] of SPLITS) {
    const gate = createTextGate();
    let released = "";
    let blocked: BlockedKind | null = null;
    for (const d of deltas) {
      const r = gate.push(d);
      if ("blocked" in r) {
        blocked = r.blocked;
        break;
      }
      released += r.text;
    }
    if (!blocked) {
      const end = gate.flush();
      if ("blocked" in end) blocked = end.blocked;
      else released += end.text;
    }
    t(`split across deltas, "${name}" is not blocked`, blocked === null, blocked);
    t(`split across deltas, "${name}" is released whole`, released === deltas.join(""), released);
  }

  // The converse, so the cases above cannot be satisfied by a gate that has
  // stopped checking: a real blocked word split at the same kind of boundary
  // is still caught, and none of it reaches the student.
  const realSplits: [string, string[]][] = [
    ["fu|ck", ["this is f", "ucking hard."]],
    ["sh|it", ["what a sh", "itshow this is."]],
    ["one character at a time", "you are a fucking idiot".split("")],
    ["only at the end of the value", ["the whole thing is bulls", "hit"]],
  ];
  for (const [name, deltas] of realSplits) {
    const gate = createTextGate();
    let released = "";
    let blocked: BlockedKind | null = null;
    for (const d of deltas) {
      const r = gate.push(d);
      if ("blocked" in r) {
        blocked = r.blocked;
        break;
      }
      released += r.text;
    }
    if (!blocked) {
      const end = gate.flush();
      if ("blocked" in end) blocked = end.blocked;
      else released += end.text;
    }
    t(`a blocked word split ${name} still latches`, blocked === "profanity", blocked);
    t(`a blocked word split ${name} was never released`, findBlockedLanguage(released) === null, released);
  }
}

// ---------------------------------------------------------------------------
console.log("streamDraftCall");
// ---------------------------------------------------------------------------

/**
 * A stand-in for the SDK's MessageStream: emits the deltas it was given, then
 * resolves finalMessage with the parsed draft - or rejects, the way an aborted
 * SDK stream does.
 */
function stubClient(deltas: string[], parsed: unknown) {
  const calls: Record<string, unknown>[] = [];
  let aborted = false;
  const make = (params: Record<string, unknown>) => {
    calls.push(params);
    let listener: ((d: string, s: string) => void) | null = null;
    return {
      on(_event: "text", fn: (d: string, s: string) => void) {
        listener = fn;
        return this;
      },
      abort() {
        aborted = true;
      },
      async finalMessage() {
        let snapshot = "";
        for (const d of deltas) {
          if (aborted) break;
          snapshot += d;
          listener?.(d, snapshot);
        }
        if (aborted) throw new Error("Request was aborted.");
        return { stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 }, parsed_output: parsed };
      },
    };
  };
  const client = {
    messages: { stream: make },
    beta: { messages: { stream: make } },
  } as unknown as Anthropic;
  return { client, calls, get aborted() { return aborted; } };
}

// ---------------------------------------------------------------------------
console.log("applyFrame / previewView - what the student sees");
// ---------------------------------------------------------------------------

/** The state the hook starts a submission in, before any frame has arrived. */
const SUBMITTED: DraftStreamState = { ...IDLE_STREAM_STATE, pending: true, stage: "starting" };

function final(body: string, subject = "Referred by Emily Tran") {
  return {
    id: "d1",
    to: "rachel@example.com",
    contactName: "Rachel Stein",
    subject,
    body,
    attachmentName: "resume.pdf",
    notes: ["Attach your resume."],
  };
}

/** Every state the machine passes through, starting from a fresh submission. */
function trace(frames: DraftStreamFrame[]): DraftStreamState[] {
  const states = [SUBMITTED];
  for (const frame of frames) states.push(applyFrame(states[states.length - 1], frame));
  return states;
}
function run(frames: DraftStreamFrame[]): DraftStreamState {
  const states = trace(frames);
  return states[states.length - 1];
}
function views(frames: DraftStreamFrame[]): PreviewView[] {
  return trace(frames).map(previewView);
}

const PLAN: DraftStreamFrame = {
  type: "plan",
  people: [{ name: "Rachel Stein", role: "the recipient, whom the student met at the panel" }],
  sentences: ["Thank her for the panel.", "Say Emily Tran sent me.", "Ask for 15 minutes."],
};
const FIRST_PASS = "Hi Rachel,\n\nEmily Tran suggested I reach out.\n\nBest,\nMaya";
const ARRIVING: DraftStreamFrame[] = [
  PLAN,
  { type: "subject", subject: "Referred by Emily Tran" },
  { type: "body-delta", text: "Hi Rachel,\n\nEmily Tran " },
  { type: "body-delta", text: "suggested I reach out.\n\nBest,\nMaya" },
  { type: "draft-finished", subject: "Referred by Emily Tran", body: FIRST_PASS },
];

{
  // 1. Arriving. Nothing is shown until a frame proves the stream is real,
  //    then the outline, then the text, and the whole way through it is
  //    labelled provisional with nothing to act on.
  const seen = views(ARRIVING);
  t("before the first frame there is no preview", seen[0].kind === "hidden", seen[0]);
  const onPlan = seen[1];
  t("the outline appears on the plan frame", onPlan.kind === "streaming" && onPlan.plan.length === 3, onPlan);
  t(
    "the plan frame alone shows no email text",
    onPlan.kind === "streaming" && onPlan.body === "" && onPlan.subject === "",
    onPlan,
  );
  t(
    "the label says it is writing once the plan is in",
    onPlan.kind === "streaming" && onPlan.label === "Writing your email…",
    onPlan,
  );
  const mid = seen[3];
  t(
    "the body shows as it arrives",
    mid.kind === "streaming" && mid.body === "Hi Rachel,\n\nEmily Tran " && mid.subject === "Referred by Emily Tran",
    mid,
  );
  t(
    "the deltas concatenate in order",
    run(ARRIVING).body === FIRST_PASS,
    run(ARRIVING).body,
  );
  const streaming = seen.slice(1);
  t(
    "every streamed view is marked provisional and has nothing to act on",
    streaming.every((v) => v.kind === "streaming" && v.provisional === true && v.actionable === false),
    streaming.map((v) => v.kind),
  );
  t(
    "every streamed view says the text is not checked yet",
    streaming.every((v) => v.kind === "streaming" && /not checked|first pass/i.test(v.sublabel)),
    streaming.map((v) => (v.kind === "streaming" ? v.sublabel : v.kind)),
  );
  t(
    "no draft exists before the final frame",
    trace(ARRIVING).every((st) => st.draft === null),
    trace(ARRIVING).map((st) => st.stage),
  );
  t(
    "nothing before the final frame reads as finished",
    seen.every((v) => v.kind !== "resolved"),
    seen.map((v) => v.kind),
  );
}

{
  // 2. The review is reading it. The text stops moving and the label says why,
  //    and it is still provisional.
  const seen = views([...ARRIVING, { type: "review-started" }]);
  const checking = seen[seen.length - 1];
  t(
    "the review stage names itself",
    checking.kind === "streaming" && checking.label.startsWith("Fact-checking"),
    checking,
  );
  t("the caret stops during the review", checking.kind === "streaming" && checking.writing === false, checking);
  t(
    "the first pass is captured for the comparison",
    run([...ARRIVING, { type: "review-started" }]).preReviewBody === FIRST_PASS,
    run([...ARRIVING, { type: "review-started" }]).preReviewBody,
  );
}

{
  // 3. Blocked halfway. The route sends the same message the finished draft
  //    would have failed with, and the provisional text has to go: what is on
  //    screen is the lead-in to text the app has just refused to show.
  const frames: DraftStreamFrame[] = [
    PLAN,
    { type: "body-delta", text: "Hi Rachel, your work as an " },
    { type: "error", message: BLOCKED_DRAFT_MESSAGE },
  ];
  const end = run(frames);
  t("blocked mid-stream clears the provisional text", end.body === "" && end.subject === "", end);
  t("blocked mid-stream clears the outline", end.plan.length === 0, end.plan);
  t("blocked mid-stream saves no draft", end.draft === null, end);
  t("blocked mid-stream reports the blocked message", end.error === BLOCKED_DRAFT_MESSAGE, end.error);
  t("blocked mid-stream stops the pending state", end.pending === false, end);
  t("blocked mid-stream shows no preview at all", previewView(end).kind === "hidden", previewView(end));
  t(
    "whatever was released before the block held no blocked language",
    findBlockedLanguage("Hi Rachel, your work as an ") === null,
  );
}

{
  // 4. The stream dies after it started. Same shape as a block - the text was
  //    never the email - but the message points at where it may have saved,
  //    because re-submitting would draft and bill a second time.
  const end = run([...ARRIVING, { type: "error", message: DEAD_STREAM }]);
  t("a dead stream clears the provisional text", end.body === "" && end.plan.length === 0, end);
  t(
    "a dead stream points at the saved drafts rather than at trying again",
    end.error === DEAD_STREAM && /past emails/i.test(DEAD_STREAM) && !/try again/i.test(DEAD_STREAM),
    end.error,
  );
  t("a dead stream shows no preview", previewView(end).kind === "hidden", previewView(end));
  t("a dead stream leaves nothing pending", end.pending === false, end);
}

{
  // 5. The review applied an edit. The swap is the moment D7 is about: the
  //    words the student just read are replaced, and they are told so and can
  //    see what changed.
  const reviewed = "Hi Rachel,\n\nEmily Tran suggested I write to you.\n\nBest,\nMaya";
  const frames: DraftStreamFrame[] = [
    ...ARRIVING,
    { type: "review-started" },
    { type: "review-finished", applied: true, problems: [{}, {}] },
    { type: "final", draft: final(reviewed) },
  ];
  const end = run(frames);
  const view = previewView(end);
  t("the final frame is the only thing that makes a draft", end.draft?.body === reviewed, end.draft);
  t("the state's text becomes the saved text", end.body === reviewed, end.body);
  t("the swap is announced", view.kind === "resolved", view);
  t(
    "the student is told the wording changed",
    view.kind === "resolved" && view.changed === true && /changed the wording/.test(view.headline),
    view,
  );
  t("the first pass is kept to compare", view.kind === "resolved" && view.firstPass === FIRST_PASS, view);
  t("the review's own verdict is recorded", view.kind === "resolved" && view.reviewApplied === true, view);
  t("nothing provisional is still on screen", view.kind === "resolved", view);
}

{
  // 6. The review changed nothing. Still said out loud: silence would leave
  //    the student unable to tell this case from the one above.
  const frames: DraftStreamFrame[] = [
    ...ARRIVING,
    { type: "review-started" },
    { type: "review-finished", applied: true, problems: [] },
    { type: "final", draft: final(FIRST_PASS) },
  ];
  const view = previewView(run(frames));
  t("an unchanged email still announces the swap", view.kind === "resolved", view);
  t(
    "the student is told the wording stood",
    view.kind === "resolved" && view.changed === false && /left the wording/.test(view.headline),
    view,
  );
  t("there is no first pass to show when nothing changed", view.kind === "resolved" && view.firstPass === null, view);
}

{
  // 7. The guard rejected the reviewer's edit. The saved body is the one that
  //    was on screen, so "changed" is measured from the text, not taken from
  //    the reviewer's own `applied` flag.
  const frames: DraftStreamFrame[] = [
    ...ARRIVING,
    { type: "review-started" },
    { type: "review-finished", applied: false, problems: [{}] },
    { type: "final", draft: final(FIRST_PASS) },
  ];
  const view = previewView(run(frames));
  t(
    "a rejected edit reports the text as unchanged",
    view.kind === "resolved" && view.changed === false && view.reviewApplied === false,
    view,
  );
}

{
  // 8. The review never ran. The pipeline's reasons are written for the
  //    student ("there wasn't time left to check it", draft-pipeline:486), so
  //    the student is given the reason and told to read the email closely.
  const reason = "there wasn't time left to check it";
  const frames: DraftStreamFrame[] = [
    ...ARRIVING,
    { type: "review-skipped", reason },
    { type: "final", draft: final(FIRST_PASS) },
  ];
  const view = previewView(run(frames));
  t(
    "a skipped review says so, in the pipeline's own words",
    view.kind === "resolved" && view.headline.includes(reason),
    view,
  );
  t(
    "a skipped review tells the student to read it closely",
    view.kind === "resolved" && /read it closely/i.test(view.headline),
    view,
  );
  t("the skip reason is recorded", view.kind === "resolved" && view.skippedReason === reason, view);
  t(
    "a skipped review does not claim the email was checked",
    view.kind === "resolved" && !/^Checked/.test(view.headline),
    view,
  );
}

{
  // 9. The unstreamed path - flag off, an old deploy, a browser that cannot
  //    stream, or a stream that never started. The finished email appears and
  //    nothing says anything about a change to text nobody saw. This is the
  //    assertion that the flag-off page is what it was.
  const end = draftArrived(final(FIRST_PASS));
  t("the action path produces the draft", end.draft?.body === FIRST_PASS && end.stage === "done", end);
  t("the action path shows no preview and no swap notice", previewView(end).kind === "hidden", previewView(end));
  t("the action path never claims anything streamed", end.streamed === false, end);
  const starting = previewView(SUBMITTED);
  t("a submission with no frames yet shows no preview", starting.kind === "hidden", starting);
}

{
  // 10. Whether to try the route at all. Checked before the request so a
  //     browser without the pieces posts the form rather than spending a
  //     request to find out.
  const whole = { fetch() {}, ReadableStream: class {}, TextDecoder: class {}, AbortController: class {} };
  t("a browser with all four streams", canStream(whole));
  t("no window at all does not stream", !canStream(undefined));
  t("no fetch does not stream", !canStream({ ...whole, fetch: undefined }));
  t("no ReadableStream does not stream", !canStream({ ...whole, ReadableStream: undefined }));
  t("no TextDecoder does not stream", !canStream({ ...whole, TextDecoder: undefined }));
  t("no AbortController does not stream", !canStream({ ...whole, AbortController: undefined }));
}

// ---------------------------------------------------------------------------
console.log("what the plan-first schema costs the student (measurement)");
// ---------------------------------------------------------------------------
//
// `draftOutputSchema` emits `plan` before `subject` and `body`, so the body
// cannot start arriving until the whole outline has been written. This section
// measures that cost rather than assuming it away: how far into the document
// the first releasable body character sits, and - at the measured throughput
// of a real draft call - how many seconds of silence that is.
//
// The inputs are measured, not invented:
//   - 132.8 words and 10 sentences per body, and a 16762 ms mean draft call:
//     scripts/audit-probe/output1/q-full.json (16 scenarios, Sonnet 5.5).
//   - 5.393 characters per word including spaces, computed over the 63
//     `notesForStudent` strings in those same two probe files - real prose
//     from this pipeline rather than a guess about English.
// The one unmeasured input is how long a plan note runs, because no plan text
// is recorded anywhere in the repo. It is swept instead, over the range the
// prompt's own examples sit in (PLAN_RULES' two sample roles are 48 and 47
// characters), and the table below is the sensitivity.

const MEASURED_DRAFT_MS = 16762;
const MEASURED_BODY_WORDS = 132.8;
const MEASURED_SENTENCES = 10;
const MEASURED_CHARS_PER_WORD = 5.393;

function prose(chars: number): string {
  // Words of eight characters plus a space - the shape does not matter, only
  // the length, and the gate's held-back tail is what makes the last word
  // arrive late, which is part of what is being measured.
  let out = "";
  while (out.length < chars) out += "espoused ";
  return out.slice(0, Math.max(1, Math.round(chars))).trimEnd();
}

/** A draft document in the schema's own key order, with the sizes asked for. */
function draftDocument(opts: { sentences: number; noteChars: number; bodyChars: number; people: number }): string {
  return JSON.stringify({
    plan: {
      people: Array.from({ length: opts.people }, (_, i) => ({
        name: `Person ${i + 1}`,
        role: prose(48),
      })),
      sentences: Array.from({ length: opts.sentences }, () => prose(opts.noteChars)),
    },
    subject: prose(42),
    body: prose(opts.bodyChars),
    connectionUsed: prose(40),
    gaps: [{ placeholder: "[your availability]", question: prose(34) }],
    notesForStudent: [prose(110)],
  });
}

/**
 * Where in the document the student first sees something, character by
 * character, through the real scanner and the real gate.
 *
 * Returns the index of the character that completed each milestone, so the
 * numbers are the stream's own behaviour and not a reading of the schema.
 */
function milestones(doc: string): { plan: number; subject: number; body: number; total: number } {
  const scanner = new TopLevelJsonScanner();
  const gate = createTextGate();
  const out = { plan: -1, subject: -1, body: -1, total: doc.length };
  for (let i = 0; i < doc.length; i++) {
    for (const event of scanner.push(doc[i])) {
      if (event.type === "value" && event.key === "plan" && out.plan < 0) out.plan = i + 1;
      if (event.type === "string-done" && event.key === "subject" && out.subject < 0) out.subject = i + 1;
      if (event.key === "body" && (event.type === "string-delta" || event.type === "string-done")) {
        const release = event.type === "string-delta" ? gate.push(event.text) : gate.flush();
        if ("text" in release && release.text && out.body < 0) out.body = i + 1;
      }
    }
  }
  return out;
}

{
  const bodyChars = Math.round(MEASURED_BODY_WORDS * MEASURED_CHARS_PER_WORD);
  const secs = (index: number, total: number) => ((index / total) * MEASURED_DRAFT_MS) / 1000;
  console.log(
    `  body ${bodyChars} chars (${MEASURED_BODY_WORDS} words x ${MEASURED_CHARS_PER_WORD}), ` +
      `draft call ${MEASURED_DRAFT_MS} ms, uniform character rate assumed`,
  );
  console.log("  note  sents  doc    outline  subject  1st body   silence before the outline / before body text");
  for (const noteChars of [40, 60, 80, 100]) {
    for (const sentences of noteChars === 60 ? [8, MEASURED_SENTENCES, 12] : [MEASURED_SENTENCES]) {
      const doc = draftDocument({ sentences, noteChars, bodyChars, people: 2 });
      const m = milestones(doc);
      console.log(
        `  ${String(noteChars).padStart(4)}  ${String(sentences).padStart(5)}  ` +
          `${String(m.total).padStart(5)}  ${String(m.plan).padStart(7)}  ${String(m.subject).padStart(7)}  ` +
          `${String(m.body).padStart(8)}   ${secs(m.plan, m.total).toFixed(1)}s / ${secs(m.body, m.total).toFixed(1)}s`,
      );
    }
  }

  // The central case, asserted so the finding cannot rot silently: on the
  // measured shape the plan is not a rounding error ahead of the body. If a
  // future schema change moves `body` first, this fails and the doc is wrong.
  const central = milestones(draftDocument({ sentences: MEASURED_SENTENCES, noteChars: 60, bodyChars, people: 2 }));
  t("the scanner reports all three milestones", central.plan > 0 && central.subject > 0 && central.body > 0, central);
  t("the outline arrives before any email text", central.plan < central.subject && central.subject < central.body, central);
  t(
    "the plan-first schema delays the first body text past a quarter of the document",
    central.body / central.total > 0.25,
    { body: central.body, total: central.total, share: central.body / central.total },
  );
  t(
    "the first body text still arrives in the first half of the wait",
    central.body / central.total < 0.6,
    { share: central.body / central.total },
  );
}

async function streamTests() {
  {
    const chunks = JSON_TEXT.match(/.{1,9}/g) ?? [];
    const stub = stubClient(chunks, DRAFT);
    const events: PipelineEvent[] = [];
    const result = await streamDraftCall(stub.client, {}, { model: "claude-opus-5" }, (e) => events.push(e));

    t("the finished message comes back parsed", result.parsed_output === DRAFT && result.stop_reason === "end_turn");
    const plan = events.find((e) => e.type === "plan");
    t("the plan is reported", plan?.type === "plan" && plan.sentences.length === 3, plan);
    const subject = events.find((e) => e.type === "subject");
    t("the subject is reported", subject?.type === "subject" && subject.subject === DRAFT.subject, subject);
    t(
      "the body deltas concatenate to the body",
      events.filter((e) => e.type === "body-delta").map((e) => (e.type === "body-delta" ? e.text : "")).join("") === DRAFT.body,
    );
    t("the plan is reported before any body text", events.findIndex((e) => e.type === "plan") < events.findIndex((e) => e.type === "body-delta"));
    t("nothing was aborted on a clean draft", !stub.aborted);

    // The stable endpoint, because the config asked for no speed.
    t("a standard config streams without speed", stub.calls[0]?.speed === undefined, stub.calls[0]);
  }

  {
    // Fast mode: the beta endpoint, with speed and the beta flag, and still parsed.
    const stub = stubClient([JSON_TEXT], DRAFT);
    await streamDraftCall(stub.client, { speed: "fast" }, { model: "claude-opus-5" }, () => {});
    t("a fast config streams with speed: fast", stub.calls[0]?.speed === "fast", stub.calls[0]);
    t("a fast config sends the fast-mode beta", JSON.stringify(stub.calls[0]?.betas) === '["fast-mode-2026-02-01"]', stub.calls[0]);
  }

  {
    // Blocked language in the body: the stream is aborted, the whole call fails
    // with the message the finished draft would have failed with, and no body
    // text containing it was ever reported.
    const dirty = JSON.stringify({ ...DRAFT, body: "Hi Rachel,\n\nThis shitshow of a process.\n\nBest,\nMaya" });
    const stub = stubClient(dirty.match(/.{1,4}/g) ?? [], null);
    const events: PipelineEvent[] = [];
    let message = "";
    await streamDraftCall(stub.client, {}, { model: "claude-opus-5" }, (e) => events.push(e)).catch((err: Error) => {
      message = err.message;
    });
    t("blocked body text fails the call", message === BLOCKED_DRAFT_MESSAGE, message);
    t("the stream was aborted", stub.aborted);
    const shown = events.filter((e) => e.type === "body-delta").map((e) => (e.type === "body-delta" ? e.text : "")).join("");
    t("no blocked word was reported", !/shitshow/i.test(shown), shown);
    t("the clean text before it was reported", shown === "Hi Rachel,\n\nThis ", shown);
  }

  {
    // Blocked language in the subject blocks before the subject is reported.
    const dirty = JSON.stringify({ ...DRAFT, subject: "That retarded process" });
    const stub = stubClient([dirty], null);
    const events: PipelineEvent[] = [];
    let message = "";
    await streamDraftCall(stub.client, {}, {}, (e) => events.push(e)).catch((err: Error) => {
      message = err.message;
    });
    t("a blocked subject fails the call", message === BLOCKED_DRAFT_MESSAGE, message);
    t("the subject was never reported", !events.some((e) => e.type === "subject"), events);
  }

  {
    // Blocked language in the plan - which is shown to the student as the
    // outline - blocks too.
    const dirty = JSON.stringify({ ...DRAFT, plan: { people: [], sentences: ["Tell this bitch no"] } });
    const stub = stubClient([dirty], null);
    const events: PipelineEvent[] = [];
    let message = "";
    await streamDraftCall(stub.client, {}, {}, (e) => events.push(e)).catch((err: Error) => {
      message = err.message;
    });
    t("a blocked plan fails the call", message === BLOCKED_DRAFT_MESSAGE, message);
    t("the plan was never reported", !events.some((e) => e.type === "plan"), events);
  }

  {
    // The same, written with JSON \u escapes. The student reads the decoded
    // characters, so that is what the check has to be run over - the raw
    // document the escapes sit in is not what anyone reads. A `people` entry
    // is checked as well as a sentence: both are reported to the browser.
    const escaped =
      '{"plan":{"people":[{"name":"Rachel","role":"a \\u0062\\u0069\\u0074\\u0063\\u0068 of a boss"}],"sentences":["One."]},' +
      '"subject":"x","body":"y","connectionUsed":null,"gaps":[],"notesForStudent":[]}';
    t("the escaped plan would slip past a check on the raw JSON", findBlockedLanguage(escaped) === null, escaped);
    const stub = stubClient([escaped], null);
    const events: PipelineEvent[] = [];
    let message = "";
    await streamDraftCall(stub.client, {}, {}, (e) => events.push(e)).catch((err: Error) => {
      message = err.message;
    });
    t("a plan blocked only once decoded fails the call", message === BLOCKED_DRAFT_MESSAGE, message);
    t("the escaped plan was never reported", !events.some((e) => e.type === "plan"), events);
  }

  {
    // A stream that dies mid-flight surfaces its own error, not the blocked one.
    const stub = stubClient(['{"plan":{"people":[],"sentences":['], null);
    const client = {
      messages: {
        stream: () => ({
          on() {
            return this;
          },
          abort() {},
          async finalMessage(): Promise<never> {
            throw new Error("connection reset");
          },
        }),
      },
    } as unknown as Anthropic;
    void stub;
    let message = "";
    await streamDraftCall(client, {}, {}, () => {}).catch((err: Error) => {
      message = err.message;
    });
    t("a dead stream reports its own failure", message === "connection reset", message);
  }

}

streamTests().then(() => {
  console.log(`\n${pass} passing, ${fail} failing`);
  if (fail) process.exitCode = 1;
});
