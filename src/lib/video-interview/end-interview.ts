import type { ClientSession } from "./types";

/**
 * Ending an interview, safely. Client-safe and framework-free, so it is tested
 * without a browser.
 *
 * The ender makes "finish" idempotent: while one request is in flight, every
 * further call returns that same request, so a double-click (or the automatic
 * finish after the last answer racing a click) sends exactly one. And it only
 * reports success when the server says the session really is complete - an
 * error, a network failure or a session still in progress is a failure the
 * page shows with a retry, never a report.
 */

export type FinishCall = (sessionId: string) => Promise<{ ok: true; data: ClientSession } | { ok: false; error: string }>;
export type EndOutcome = { ok: true; session: ClientSession } | { ok: false; error: string };

export function createInterviewEnder(finish: FinishCall) {
  let inFlight: Promise<EndOutcome> | null = null;
  return {
    get busy(): boolean {
      return inFlight !== null;
    },
    end(sessionId: string): Promise<EndOutcome> {
      if (inFlight) return inFlight;
      const run = (async (): Promise<EndOutcome> => {
        try {
          const res = await finish(sessionId);
          if (!res.ok) return { ok: false, error: res.error };
          if (res.data.status !== "complete") return { ok: false, error: "The interview couldn't be finished yet. Try again." };
          return { ok: true, session: res.data };
        } catch {
          return { ok: false, error: "Couldn't reach the server to finish the interview. Check your connection and try again." };
        }
      })();
      inFlight = run.finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

type Recorderish = { state: string; stop: () => void } | null | undefined;

/** Stops every recorder that is still running. Returns how many it stopped. */
export function stopActiveRecorders(recorders: Recorderish[]): number {
  let stopped = 0;
  for (const r of recorders) {
    if (r && r.state !== "inactive") {
      try {
        r.stop();
        stopped++;
      } catch {
        // Already stopping: nothing more to do.
      }
    }
  }
  return stopped;
}
