// Timing assertions that survive a loaded machine.
//
// WHY THIS EXISTS. Two tests asserted a wall-clock ceiling on work whose
// regression was a complexity blow-up, and both failed on a laptop that was
// building and running evals at the same time. The numbers from
// import-dedupe-and-caps show why raising the ceiling is not the fix:
//
//   the regression it guards     8,000 ms
//   the fixed code               16 ms
//   the fixed code, under load   67,410 ms   <- the flake
//
// The ranges OVERLAP. No single ceiling separates a broken-but-idle machine
// from a working-but-busy one, so any threshold is either flaky or blind.
//
// What does separate them is SHAPE. The fixed code is linear in its input and
// the regression is quadratic or worse, so timing the same work at two input
// sizes back to back cancels machine speed and most contention - both halves
// pay it. A ratio near 2 for a doubled input is linear; near 4 is quadratic.
//
// Two techniques, both standard for timing under noise:
//
// - MINIMUM, not mean. Contention can only ever make a sample slower, so the
//   minimum of several runs is the closest cheap estimate of the uncontended
//   time. A mean is dragged around by whatever else the machine was doing.
// - RATIO, not absolute. See above.
//
// Keep a generous absolute ceiling alongside the ratio where a true hang is
// the failure mode worth catching - a wedged event loop never returns, so a
// ceiling twenty times the expected cost still catches it and never trips on
// load.

/** Milliseconds for the fastest of `reps` runs. Contention only adds time, so the minimum is the cleanest estimate. */
export function minTime(run: () => void, reps = 5): number {
  let best = Infinity;
  for (let i = 0; i < reps; i += 1) {
    const started = process.hrtime.bigint();
    run();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms < best) best = ms;
  }
  return best;
}

/** Milliseconds for the fastest of `reps` runs of an async operation. */
export async function minTimeAsync(run: () => Promise<void>, reps = 3): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < reps; i += 1) {
    const started = process.hrtime.bigint();
    await run();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms < best) best = ms;
  }
  return best;
}

/**
 * How much slower the work gets when its input doubles.
 *
 * ~2 is linear, ~4 quadratic, and anything above that is the shape these tests
 * exist to catch. Returns the ratio and both timings so a failure message can
 * show its work.
 *
 * A floor is applied to the small measurement: a sub-millisecond baseline makes
 * the ratio meaningless, since timer granularity alone can double it. When the
 * small case is too fast to measure, the ratio is reported as 1 - there is no
 * blow-up to see at this size, and the caller's absolute ceiling is the gate.
 */
export function growth(small: () => void, large: () => void, reps = 5): { ratio: number; smallMs: number; largeMs: number } {
  const smallMs = minTime(small, reps);
  const largeMs = minTime(large, reps);
  const ratio = smallMs < 0.05 ? 1 : largeMs / smallMs;
  return { ratio, smallMs, largeMs };
}
