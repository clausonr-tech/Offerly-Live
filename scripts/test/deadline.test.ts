import { test } from "node:test";
import assert from "node:assert/strict";

import {
  withAmbientSignal,
  currentDeadlineSignal,
  isDeadlineExpired,
  withAmbientDeadline,
  DeadlineExpired,
} from "../../src/lib/monitoring/deadline";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("the signal is visible to code that never heard of the budget", async () => {
  // The point of the ambient carrier: safeFetch reads this without any
  // connector having to pass it down. Twenty-two connectors would otherwise
  // each have to remember, and one that forgot would compile and run.
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  await withAmbientSignal(controller.signal, async () => {
    seen = currentDeadlineSignal();
  });
  assert.equal(seen, controller.signal, "the caller's own signal is what is carried");
});

test("there is no ambient signal outside one", () => {
  // Every test and every script that is not the crawl runs here, and must
  // behave exactly as it did before this file existed.
  assert.equal(currentDeadlineSignal(), undefined);
});

test("aborting the caller's controller reaches work deep inside", async () => {
  // The shape withBudget relies on: it owns the controller and the timer, and
  // the abort has to arrive somewhere it never passed a parameter to.
  const controller = new AbortController();
  const reasons: unknown[] = [];

  const task = withAmbientSignal(controller.signal, async () => {
    // Stands in for safeFetch, several frames down and holding no reference
    // to anything above it.
    const signal = currentDeadlineSignal()!;
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          reasons.push(signal.reason);
          resolve();
        },
        { once: true },
      );
    });
  });

  controller.abort(new DeadlineExpired(180_000));
  await task;
  assert.equal(reasons.length, 1, "the abort arrived exactly once");
  assert.ok(isDeadlineExpired(reasons[0]), "carrying the reason, not just the fact");
});

test("nothing is swallowed - the caller still sees what the work threw", async () => {
  // The distinction the scheduler depends on: withBudget tells an over-budget
  // source from a broken one, so this must not flatten them into each other.
  const controller = new AbortController();
  await assert.rejects(
    withAmbientSignal(controller.signal, async () => {
      throw new Error("the board 404'd");
    }),
    /the board 404'd/,
  );
});

test("a value passes straight back through", async () => {
  const controller = new AbortController();
  assert.equal(
    await withAmbientSignal(controller.signal, async () => "done"),
    "done",
  );
});

test("expiry is recognisable across a module boundary", () => {
  assert.equal(isDeadlineExpired(new Error("nope")), false);
  assert.equal(isDeadlineExpired({ name: "DeadlineExpired" }), true);
  assert.equal(isDeadlineExpired(new DeadlineExpired(180_000)), true);
});

test("a subclass is still a deadline, so it is named as ours", async () => {
  // `BudgetExpired` in monitor-run.ts extends DeadlineExpired, and the abort
  // reason travels: it is the error a cancelled in-flight read rejects with,
  // and fetch-reason.ts has to call that our own budget rather than the board
  // failing to answer.
  class BudgetExpired extends DeadlineExpired {
    constructor() {
      super(180_000);
      this.name = "BudgetExpired";
    }
  }
  assert.equal(isDeadlineExpired(new BudgetExpired()), true);
});

test("the signal is combined with a caller's own, not replaced by it", async () => {
  const outer = new AbortController();
  await withAmbientSignal(outer.signal, async () => {
    const mine = new AbortController();
    const both = withAmbientDeadline(mine.signal)!;
    assert.equal(both.aborted, false);
    mine.abort(new Error("caller changed its mind"));
    // Either reason must stop the request; safeFetch relies on this to keep
    // its own per-hop timeout alongside the run's budget.
    await sleep(0);
    assert.equal(both.aborted, true);
  });
});

test("with nothing to combine, there is no signal to pass", () => {
  assert.equal(withAmbientDeadline(undefined), undefined);
});
