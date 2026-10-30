/**
 * The per-source budget CANCELS the source it gives up on.
 *
 * `withBudget` in scripts/monitor-run.ts used to race a check against a
 * 180-second timer and return, leaving the check running - its own comment said
 * it "will finish in the background". That is the opposite of what a per-source
 * budget is for: the abandoned check keeps a fetch-pool slot, a Chromium tab on
 * the generic connector and a database connection, and goes on writing to a
 * source the run has already moved past. Twenty slow sources in a run meant
 * twenty of them still going.
 *
 * What is asserted here, against the real withBudget:
 *
 *   - the task is handed an AbortSignal, and the budget firing aborts it;
 *   - the abort reason is a BudgetExpired, so checkSource's catch can tell it
 *     apart from a fault of the board and leave failureCount alone;
 *   - the worker is not made to wait for the cancelled task, and is not handed
 *     an error either: an over-budget source is logged and the run continues;
 *   - a task that fails AFTER the abort does not become an unhandled rejection,
 *     which in Node would end the whole crawl;
 *   - a task that finishes inside its budget is never aborted, and a real
 *     failure inside its budget still reaches the worker.
 *
 * No database and no network: the module is imported with
 * OFFERLY_MONITOR_IMPORT_ONLY set, so main() does not run, and the budget's own
 * bookkeeping write is already wrapped in a try/catch that swallows a database
 * that is not there (it is bookkeeping, never the run's problem).
 */

import assert from "node:assert/strict";
import test from "node:test";

import "./helpers/no-network";

// Both read at module load, so they are set before the import below.
process.env.OFFERLY_MONITOR_IMPORT_ONLY = "1";
process.env.OFFERLY_SOURCE_BUDGET_MS = "60";

// Imported inside the tests rather than at the top: this file compiles to CJS
// under the test runner, where a top-level await is not available.
const budget = () => import("../monitor-run");

const SOURCE = { id: "11111111-2222-4222-8222-111111111111", firm: { name: "Slow Board LLP" } };

const never = () => new Promise<void>(() => {});

test("the budget aborts the task it gave up on, and the run carries on", async () => {
  const { withBudget, BudgetExpired } = await budget();
  // Collected rather than assigned to a `let`: the assignment happens inside a
  // callback, and a narrowed `AbortSignal | null` reads as never afterwards.
  const handed: AbortSignal[] = [];
  const reasons: unknown[] = [];

  const started = Date.now();
  await withBudget(SOURCE, async (signal) => {
    handed.push(signal);
    signal.addEventListener("abort", () => reasons.push(signal.reason));
    // A check that would never end on its own - a board paging forever, a page
    // that never settles. Before this change, this promise outlived the run.
    await never();
  });
  const elapsed = Date.now() - started;

  assert.equal(handed.length, 1, "the task is handed a signal");
  assert.equal(handed[0].aborted, true, "which the budget aborts");
  assert.equal(reasons.length, 1, "exactly once");
  assert.ok(
    reasons[0] instanceof BudgetExpired,
    "with a reason checkSource can tell from a fault of the board",
  );
  assert.match(String((reasons[0] as Error).message), /Slow Board LLP/, "naming the source");
  // The worker moved on rather than waiting for a task that never ends.
  assert.ok(elapsed < 5_000, `withBudget returned promptly (${elapsed}ms)`);
});

test("a cancelled task that then throws does not take the run down", async () => {
  const { withBudget, BudgetExpired } = await budget();
  // The shape checkSource actually produces: it checks the signal at its next
  // stage boundary and throws BudgetExpired out of the middle of the check.
  await withBudget(SOURCE, async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    throw new BudgetExpired(SOURCE.firm.name);
  });

  // And anything else it may throw on the way out is absorbed too - after the
  // budget has fired there is nobody left to hand an error to, and an
  // unhandled rejection ends the process.
  await withBudget(SOURCE, async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    throw new Error("a connector blew up while unwinding");
  });

  // A tick for any rejection that was going to go unhandled to do so: this
  // test file fails on an unhandled rejection, which is the assertion.
  await new Promise((r) => setTimeout(r, 50));
});

test("a source inside its budget is never touched, and its errors still land", async () => {
  const { withBudget } = await budget();
  let aborted = true;
  await withBudget(SOURCE, async (signal) => {
    aborted = signal.aborted;
  });
  assert.equal(aborted, false, "a fast source is not handed an aborted signal");

  await assert.rejects(
    withBudget(SOURCE, async () => {
      throw new Error("HTTP 500 from the board");
    }),
    /HTTP 500 from the board/,
    "a real failure inside the budget still reaches the worker's catch",
  );
});

/**
 * The half the stage checkpoints cannot cover.
 *
 * `checkSource` checks the signal at every stage boundary, which stops a
 * cancelled source between stages - but a checkpoint is never reached while the
 * code is stuck inside one request, and that is the shape of the 18,002-second
 * p95 this budget was measured against. `SourceRef` carries no `signal` field,
 * so no connector is handed one; the signal travels in ambient scope instead
 * (src/lib/monitoring/deadline.ts), where `safeFetch` and the generic
 * connector's `withPage` read it.
 *
 * Asserted here rather than left to the two readers, because nothing about a
 * connector's own code would fail if the carrier stopped being installed: the
 * crawl would simply go back to not cancelling, which is how this was missed
 * for the system's entire history.
 */
test("the budget's signal reaches code it was never passed to", async () => {
  const { withBudget, BudgetExpired } = await budget();
  const { currentDeadlineSignal, isDeadlineExpired } = await import(
    "../../src/lib/monitoring/deadline"
  );

  let ambient: AbortSignal | undefined;
  let handed: AbortSignal | undefined;
  const reasons: unknown[] = [];

  await withBudget(SOURCE, async (signal) => {
    handed = signal;
    // Several frames down, holding no reference to anything above it - the
    // position safeFetch is in.
    await (async () => {
      ambient = currentDeadlineSignal();
      const s = currentDeadlineSignal()!;
      await new Promise<void>((resolve) => {
        s.addEventListener("abort", () => {
          reasons.push(s.reason);
          resolve();
        });
      });
    })();
    await never();
  });

  assert.ok(ambient, "safeFetch would see no signal at all");
  assert.equal(ambient, handed, "the ambient signal is the budget's own, not a copy");
  assert.equal(reasons.length, 1, "the abort reached the inner frame");
  assert.ok(
    reasons[0] instanceof BudgetExpired,
    "an aborted in-flight read rejects with the budget's reason",
  );
  assert.ok(
    isDeadlineExpired(reasons[0]),
    "so fetch-reason.ts calls it our own budget, not the board failing to answer",
  );
});
