import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The run-wide "stop now" signal, carried rather than passed.
 *
 * WHAT WAS WRONG
 * --------------
 * `monitor-run.ts` has a per-source budget of three minutes. It was enforced
 * with `Promise.race([run(), budget])`, and its own comment admitted what
 * that means: "The check that is still running owns its own writes and will
 * finish in the background. This only stops the WORKER waiting for it."
 *
 * Nothing was cancelled. The worker moved on and the abandoned check kept a
 * fetch-pool slot, a database connection and a Chrome tab for as long as it
 * liked. Measured 11 October 2026 over 28,597 check runs: `changed` runs
 * averaged 1,141 seconds against a 180-second budget, with a 95th percentile
 * of 18,002 seconds - five hours - and one error run at 36 hours. Thirty-eight
 * runs were still open with no finish time at all. A budget that does not
 * cancel is a log line.
 *
 * `withBudget` now aborts a controller when the budget fires, and `checkSource`
 * checks that signal at every stage boundary. THIS FILE IS THE OTHER HALF: a
 * stage checkpoint is never reached while the code is stuck inside a single
 * request, and that is the shape of the 18,002-second runs.
 *
 * WHY AMBIENT AND NOT A PARAMETER
 * -------------------------------
 * The honest alternative is to add `signal` to `SourceConnector.fetch()` and
 * thread it through all twenty-two connectors. That has a failure mode this
 * repository has just paid for twice: a new connector that forgets to pass it
 * compiles, runs, and silently cannot be cancelled - the same shape as the
 * script that forgot DATABASE_URL and read a dead database for three weeks.
 *
 * Cancellation is a property of the RUN, not of the source, which is what
 * AsyncLocalStorage is for. One `withAmbientSignal` at the top and one read
 * inside `safeFetch` makes every request in the subtree cancellable, including
 * ones in code that has never heard of this file.
 *
 * NO TIMER LIVES HERE. The budget, the race that stops the worker waiting and
 * the bookkeeping all belong to `withBudget`, which owns the controller; this
 * file only carries the signal to where it can be read. Two timers for one
 * budget is the kind of duplication that drifts.
 *
 * Outside a `withAmbientSignal` - every test, every script that is not the
 * crawl - `currentDeadlineSignal()` returns undefined and nothing changes.
 */

type Scope = { signal: AbortSignal };

const scope = new AsyncLocalStorage<Scope>();

/**
 * Run `fn` with `signal` in ambient scope.
 *
 * The caller owns the signal and decides what aborts it and when. For the
 * crawl that is `withBudget` in scripts/monitor-run.ts: its controller is
 * aborted by the per-source budget with a `BudgetExpired`, and passing that
 * same signal here is what carries it down to `safeFetch` and to the generic
 * connector's `withPage`.
 *
 * Returns whatever `fn` returns and swallows nothing - an abort surfaces as
 * whatever the aborted operation throws, which the caller is already handling.
 */
export function withAmbientSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return scope.run({ signal }, fn);
}

/** The ambient signal, or undefined outside a `withAmbientSignal`. */
export function currentDeadlineSignal(): AbortSignal | undefined {
  return scope.getStore()?.signal;
}

export class DeadlineExpired extends Error {
  constructor(readonly budgetMs: number) {
    super(`over the ${Math.round(budgetMs / 1000)}s budget`);
    this.name = "DeadlineExpired";
  }
}

export function isDeadlineExpired(err: unknown): err is DeadlineExpired {
  return err instanceof DeadlineExpired || (err as { name?: string })?.name === "DeadlineExpired";
}

/**
 * Combine a deadline with whatever signal the caller already had.
 *
 * `AbortSignal.any` ignores undefined entries badly, so they are filtered
 * here rather than at each of the three call sites.
 */
export function withAmbientDeadline(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const all = [...signals, currentDeadlineSignal()].filter((s): s is AbortSignal => Boolean(s));
  if (all.length === 0) return undefined;
  if (all.length === 1) return all[0];
  return AbortSignal.any(all);
}

/**
 * Did this check spend more time than its budget allowed? By how much?
 *
 * WHY THIS EXISTS. The budget is enforced two ways - stage checkpoints inside
 * `checkSource`, and the ambient signal this file carries, which `safeFetch`
 * and the generic connector's `withPage` read. The ambient half appears in no
 * function signature, and NOTHING FAILS if it stops being installed: the crawl
 * quietly goes back to not cancelling, which is how a 180-second budget ran
 * against reads averaging 1,141 seconds for the system's entire history.
 *
 * Making it visible in signatures means threading a signal through twenty-two
 * connectors, which is the cost that was rejected for good reason. So it is
 * made measurable instead, which is this codebase's own preference: prefer a
 * measurement to a mechanism.
 *
 * MEASURED FROM STAGES, NOT FROM THE CLOCK. A run's wall time includes waiting
 * for a slot in the fetch pool, so a queued source can finish long after its
 * budget with cancellation working perfectly - alarming on elapsed time would
 * cry wolf on every busy cycle. Only time actually spent on the source can
 * show an overrun.
 *
 * An unreported stage contributes nothing rather than being invented, so the
 * total can only ever understate. That direction is deliberate: an alarm that
 * understates stays quiet when it should not, and one that overstates gets
 * turned off.
 *
 * ENRICHMENT IS DELIBERATELY NOT COUNTED, for the same reason the wall clock
 * is not. `enrich_ms` is measured around `backfillThinListings`, which calls
 * `pooledFetch` itself, so it contains `takeDomainTurn`, `acquireSlot` and
 * `awaitSpacing` - the per-domain gap alone is 2s, and 10s for one host. Only
 * `static_ms` and `render_ms` are measured INSIDE the connector, after the
 * slot is already held, so only they are time this source actually spent. An
 * alarm fed the other number would fire on every busy cycle and be turned off,
 * which is the failure this whole function is written to avoid.
 */
export function budgetOverrunMs(
  stages: { staticMs?: number | null; renderMs?: number | null },
  budgetMs: number,
): number | null {
  const spent = (stages.staticMs ?? 0) + (stages.renderMs ?? 0);
  return spent > budgetMs ? spent - budgetMs : null;
}
