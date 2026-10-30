/**
 * If cancelling stopped working, we would not be able to tell.
 *
 * The per-source budget is enforced two ways: stage checkpoints inside
 * `checkSource`, and an ambient `AbortSignal` that `safeFetch` and the generic
 * connector's browser read. The ambient half appears in no function signature,
 * and nothing fails if it stops being installed - the crawl simply goes back
 * to not cancelling, which is how that went unnoticed for the system's entire
 * history.
 *
 * It cannot be made visible in signatures without threading a signal through
 * twenty-two connectors, which is the cost that was rejected. So it is made
 * MEASURABLE instead, now that the per-stage timings exist.
 *
 * ELAPSED TIME WOULD NOT WORK. A run's wall clock includes waiting for a slot
 * in the fetch pool, so a queued source can exceed the budget with cancelling
 * working perfectly. Only time actually SPENT on the source can prove it
 * overran, which is exactly what static/render/enrich measure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { budgetOverrunMs } from "../../src/lib/monitoring/deadline";

test("time spent inside the budget raises nothing", () => {
  assert.equal(budgetOverrunMs({ staticMs: 1200, renderMs: 4000 }, 180_000), null);
  assert.equal(budgetOverrunMs({}, 180_000), null, "a connector reporting nothing is not an overrun");
});

test("enrichment is not counted - it carries the fetch pool's queue time", () => {
  // `enrich_ms` is measured around calls that acquire their own pool slot, so
  // it contains waiting as well as working. Feeding it to the alarm is what
  // would make it cry wolf on a busy cycle, so the signature cannot take it.
  // @ts-expect-error enrichMs is deliberately not part of the input
  assert.equal(budgetOverrunMs({ staticMs: 1_000, enrichMs: 500_000 }, 180_000), null);
});

test("time spent past the budget is the overrun, in ms", () => {
  // Cancelling should have stopped this at 180s; it spent 200s on stages.
  assert.equal(budgetOverrunMs({ staticMs: 60_000, renderMs: 140_000 }, 180_000), 20_000);
});

test("a missing stage counts as zero, never as instant success", () => {
  // Null means "not reported" and must not be read as 0ms of work, but it
  // also cannot be invented - so it contributes nothing to the total and the
  // total can only ever understate. An alarm that understates is safe; one
  // that overstates cries wolf.
  assert.equal(budgetOverrunMs({ staticMs: null, renderMs: 190_000 }, 180_000), 10_000);
});

test("the budget itself is never treated as an overrun", () => {
  // Exactly at the limit is the limit holding, not failing.
  assert.equal(budgetOverrunMs({ staticMs: 180_000 }, 180_000), null);
});
