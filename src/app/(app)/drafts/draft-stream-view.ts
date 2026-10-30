// What the student sees while the email is being written, as a pure function
// of the frames the streaming route has sent so far.
//
// No React and no server imports on purpose. The interesting part of a
// streaming UI is not its markup, it is the order it has to survive: a plan
// that arrives before any email text, a body that arrives in pieces, a check
// that can reject the whole thing halfway, a connection that can stop without
// saying why, and a review that can rewrite what is already on screen. All of
// that is decided here, so scripts/draft-stream-test.ts can drive every one of
// those orders directly instead of a browser having to.
//
// The one rule the whole file exists to keep: NOTHING reachable before
// `stage === "done"` is the email. It has not been through the review pass,
// the deterministic fixes or the final blocked-language gate, and the student
// is told so in as many words and given nothing to copy, edit or send.

import type { ComposerDraft } from "./draft-request";

export type DraftStreamStage =
  /** Nothing submitted yet. */
  | "idle"
  /** Waiting for the first word. */
  | "starting"
  /** The model is writing. The text on screen is provisional. */
  | "writing"
  /** The model has finished; the review pass is reading it. Still provisional. */
  | "checking"
  /** Saved and gated. `draft` is the email of record. */
  | "done";

export type DraftStreamState = {
  pending: boolean;
  stage: DraftStreamStage;
  /** The model's outline of the email, one line per sentence it means to write. */
  plan: string[];
  /** Provisional until `stage` is "done" - see DraftStreamPreview. */
  subject: string;
  body: string;
  /** The draft as it stood before the review pass, once the review has run. */
  preReviewBody: string | null;
  /** Whether the review said it applied an edit. Null until it has finished. */
  reviewApplied: boolean | null;
  /** Why the review didn't run, when it didn't. */
  reviewSkipped: string | null;
  /** The saved, fully checked draft. Only ever set at the end. */
  draft: ComposerDraft | null;
  error: string | null;
  /**
   * Whether any provisional text was ever on screen for this submission.
   *
   * Load-bearing: with the flag off (or after a fallback to the server action)
   * the student watched a spinner and the finished email simply appears, which
   * is today's behaviour and must stay byte-for-byte that. The "here is what
   * the review changed" strip would be noise about text they never saw, so it
   * is shown only when they did see it.
   */
  streamed: boolean;
};

export const IDLE_STREAM_STATE: DraftStreamState = {
  pending: false,
  stage: "idle",
  plan: [],
  subject: "",
  body: "",
  preReviewBody: null,
  reviewApplied: null,
  reviewSkipped: null,
  draft: null,
  error: null,
  streamed: false,
};

/**
 * What the student is told when the connection stops mid-draft.
 *
 * Not "try again": the draft may already be written and already charged to
 * their monthly allowance, so the honest instruction is to go and look.
 */
export const DEAD_STREAM =
  "The connection dropped while your email was being written. Check Your past emails - it may have saved.";

/** One `data: {...}` frame from the route - PipelineEvent plus the route's own two. */
export type DraftStreamFrame =
  | { type: "plan"; people: { name: string; role: string }[]; sentences: string[] }
  | { type: "subject"; subject: string }
  | { type: "body-delta"; text: string }
  | { type: "draft-finished"; subject: string; body: string }
  | { type: "review-started" }
  | { type: "review-finished"; applied: boolean; problems: unknown[] }
  | { type: "review-skipped"; reason: string }
  | { type: "final"; draft: ComposerDraft }
  | { type: "error"; message: string };

/**
 * The state machine. One frame in, the next state out.
 *
 * Two cases deserve their reasoning written down:
 *
 *  - `error` returns to idle with only the message. Every frame before it was
 *    provisional, and the two ways a stream ends in an error are exactly the
 *    two where leaving the text up would be dangerous: the blocked-language
 *    gate latched (so what is on screen is the lead-in to text the app has
 *    just refused to show), or the connection died (so what is on screen is
 *    half an email that will never be checked). A student looking at either
 *    one has something that looks copyable and isn't. It goes.
 *
 *  - `final` is the only frame that produces an email. It replaces `subject`
 *    and `body` outright, which is the swap the student must be shown rather
 *    than have slipped past them; `preReviewBody` is kept so the strip can say
 *    what changed and show the first pass beside it.
 */
export function applyFrame(prev: DraftStreamState, frame: DraftStreamFrame): DraftStreamState {
  switch (frame.type) {
    case "plan":
      return {
        ...prev,
        stage: prev.stage === "starting" ? "writing" : prev.stage,
        plan: frame.sentences,
        streamed: true,
      };
    case "subject":
      return { ...prev, stage: "writing", subject: frame.subject, streamed: true };
    case "body-delta":
      return { ...prev, stage: "writing", body: prev.body + frame.text, streamed: true };
    case "draft-finished":
      // The deterministic fixes have run, so the text settles here rather than
      // drifting character by character.
      return { ...prev, stage: "writing", subject: frame.subject, body: frame.body, streamed: true };
    case "review-started":
      return { ...prev, stage: "checking", preReviewBody: prev.body };
    case "review-finished":
      return { ...prev, reviewApplied: frame.applied };
    case "review-skipped":
      return { ...prev, reviewApplied: false, reviewSkipped: frame.reason };
    case "final":
      return {
        ...prev,
        pending: false,
        stage: "done",
        draft: frame.draft,
        subject: frame.draft.subject,
        body: frame.draft.body,
      };
    case "error":
      return { ...IDLE_STREAM_STATE, error: frame.message };
  }
}

/** The finished, checked email arriving with nothing having been streamed - the server action's path. */
export function draftArrived(draft: ComposerDraft): DraftStreamState {
  return {
    ...IDLE_STREAM_STATE,
    stage: "done",
    draft,
    subject: draft.subject,
    body: draft.body,
  };
}

// ---------------------------------------------------------------------------
// What is on screen
// ---------------------------------------------------------------------------

export type PreviewView =
  /** Nothing to show: idle, failed, or a draft that was never streamed. */
  | { kind: "hidden" }
  | {
      kind: "streaming";
      /** The header line: what is happening right now. */
      label: string;
      /** The quiet second line - why the text may still change. */
      sublabel: string;
      /** The model's outline, once it has arrived. */
      plan: string[];
      subject: string;
      body: string;
      /** True while the drafting model is writing; false once the review is reading it. */
      writing: boolean;
      /** Always true here. Nothing in this view has been through the review or the final gate. */
      provisional: true;
      /** Always false here. There is no Copy, no Send, no editable field. */
      actionable: false;
    }
  | {
      kind: "resolved";
      /** What the student is told at the moment the checked email replaces the provisional one. */
      headline: string;
      /** Whether the saved body differs from what was on screen - measured, not taken on trust. */
      changed: boolean;
      /** What the review itself said it did. Null when it never finished. */
      reviewApplied: boolean | null;
      /**
       * Why the review didn't run, in the pipeline's own words - which are
       * written for the student ("there wasn't time left to check it"), so
       * they go in the headline rather than being hidden behind a log line.
       */
      skippedReason: string | null;
      /** The pre-review text, offered behind a disclosure so the change is checkable. */
      firstPass: string | null;
    };

const WRITING_SUBLABEL = "Not checked yet - Offerly is still reading it against your details.";

/**
 * The view for a state. The component renders this and decides nothing itself.
 *
 * `resolved` appears only when provisional text was actually on screen, and it
 * always says which way the swap went, because a silent replacement is the one
 * outcome D7 forbids: a student who looked away for two seconds would have no
 * way to know the words in front of them are not the words they just read.
 */
export function previewView(state: DraftStreamState): PreviewView {
  if (state.error) return { kind: "hidden" };

  // Nothing has arrived over the wire, so there is nothing provisional to
  // show and no way to know there will be: the flag may be off, the route may
  // 404, the browser may not stream. The form keeps its ordinary pending
  // state (StagedProgress) until the first frame proves otherwise, which is
  // what keeps the flag-off path exactly what it is today.
  if (!state.streamed) return { kind: "hidden" };

  if (state.stage === "starting" || state.stage === "writing" || state.stage === "checking") {
    const writing = state.stage !== "checking";
    const label =
      state.stage === "checking"
        ? "Fact-checking every line against your details…"
        : state.body
          ? "Writing your email…"
          : state.plan.length > 0
            ? "Writing your email…"
            : "Planning your email…";
    return {
      kind: "streaming",
      label,
      sublabel: writing ? WRITING_SUBLABEL : "This is still the first pass. The checked email replaces it when the review finishes.",
      plan: state.plan,
      subject: state.subject,
      body: state.body,
      writing,
      provisional: true,
      actionable: false,
    };
  }

  if (state.stage === "done" && state.draft) {
    const firstPass = state.preReviewBody;
    const changed = firstPass !== null && firstPass !== state.draft.body;
    const headline = state.reviewSkipped
      ? `Saved, but ${state.reviewSkipped}. Read it closely before you send it.`
      : changed
        ? "Checked and saved. The review changed the wording - the email below is the final one."
        : "Checked and saved. The review left the wording as it was - the email below is the final one.";
    return {
      kind: "resolved",
      headline,
      changed,
      reviewApplied: state.reviewApplied,
      skippedReason: state.reviewSkipped,
      firstPass: changed ? firstPass : null,
    };
  }

  return { kind: "hidden" };
}

// ---------------------------------------------------------------------------
// Can this browser read a stream at all
// ---------------------------------------------------------------------------

/**
 * Whether to try the streaming route in this browser.
 *
 * Checked before the request rather than discovered from a missing
 * `response.body`, so a browser without the pieces posts the form the way it
 * always has instead of spending a request to find out. Every name here is
 * used by `streamSubmit`: `fetch` to make the call, `ReadableStream` and
 * `TextDecoder` to read it, `AbortController` to stop it when the student
 * navigates away mid-draft.
 */
export function canStream(scope: Record<string, unknown> | undefined): boolean {
  if (!scope) return false;
  return (
    typeof scope.fetch === "function" &&
    typeof scope.ReadableStream === "function" &&
    typeof scope.TextDecoder === "function" &&
    typeof scope.AbortController === "function"
  );
}
