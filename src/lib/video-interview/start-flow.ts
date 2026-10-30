import type { TrainingChoice } from "./types";

/**
 * "Start interview", as a small state machine the page drives - client-safe
 * and framework-free so its guarantees are tested without a browser:
 *
 *   closed --open()--> choosing --choose(yes|no)--> starting --ok--> closed
 *                        |  ^                          |
 *                  cancel()  +------ failed -----------+
 *
 * - Opening only opens the question: no session is created and nothing asks
 *   for the camera until the student answers.
 * - There is no default answer; `choose` needs an explicit "yes" or "no".
 * - One Start = one token. However many times `choose` is called while a
 *   request is out (a double-click), it returns that same request; and a
 *   retry after a failure reuses the token, so the server returns the
 *   session it may already have made instead of creating a second one.
 */

export type StartFlowState = "closed" | "choosing" | "starting";
/** `context` is whatever the page passes to choose() - e.g. its current setup. */
export type StartCall<T, C = unknown> = (choice: TrainingChoice, startToken: string, context: C) => Promise<{ ok: true; data: T } | { ok: false; error: string }>;

function newStartToken(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createStartFlow<T, C = unknown>(start: StartCall<T, C>, onChange: (s: { state: StartFlowState; error: string | null }) => void = () => {}) {
  let state: StartFlowState = "closed";
  let error: string | null = null;
  let token: string | null = null;
  let inFlight: Promise<{ ok: true; data: T } | { ok: false; error: string }> | null = null;
  const set = (s: StartFlowState, e: string | null = null) => {
    state = s;
    error = e;
    onChange({ state, error });
  };

  return {
    get state() {
      return state;
    },
    get error() {
      return error;
    },
    open() {
      if (state !== "closed") return;
      token = newStartToken();
      set("choosing");
    },
    cancel() {
      if (state === "starting") return; // a request is out; let it settle
      token = null;
      set("closed");
    },
    choose(choice: TrainingChoice, context?: C) {
      if (inFlight) return inFlight;
      if (state !== "choosing" || !token || (choice !== "yes" && choice !== "no")) {
        return Promise.resolve({ ok: false as const, error: "Choose yes or no to start." });
      }
      set("starting");
      const run = start(choice, token, context as C)
        .catch(() => ({ ok: false as const, error: "Couldn't start the interview. Check your connection and try again." }))
        .then((res) => {
          if (res.ok) {
            token = null;
            set("closed");
          } else set("choosing", res.error); // same token kept for the retry
          return res;
        })
        .finally(() => {
          inFlight = null;
        });
      inFlight = run;
      return run;
    },
  };
}

/**
 * Where Tab should land inside a modal dialog: wraps from the last focusable
 * element to the first (and, with Shift, from the first to the last), and
 * pulls focus back in if it is anywhere else (-1).
 */
export function trapFocusIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  if (shift) return current === 0 ? count - 1 : current - 1;
  return current === count - 1 ? 0 : current + 1;
}
