/**
 * When a click costs a run, and when it must not.
 *
 * Pure rules, separated from the database work, so the billing and caching
 * decisions can be exercised exhaustively offline. The action's job is to
 * apply what these return inside one transaction.
 *
 * The principle underneath all of it: a student pays for people, not for
 * attempts. A run that returns nobody, fails, or simply re-reads what they
 * already have has cost them nothing they can use, so it costs them nothing.
 */

export type RequestMode = "generate" | "refresh" | "fill";

/**
 * The key that makes a click idempotent.
 *
 * (user, recommendation, mode) rather than a random token per press: two
 * clicks a few hundred milliseconds apart are the SAME intent, and the second
 * must join the first rather than start a rival run. A browser-side disabled
 * button does not survive a double-submit, a reload mid-flight, or two tabs.
 *
 * `fill` deliberately shares its key with the `generate` it completes, which
 * is what makes a top-up free: it is the same request finishing, not a new one.
 */
export function idempotencyKey(input: {
  userId: string;
  recommendationId: string;
  mode: RequestMode;
  /** Distinguishes successive refreshes, which ARE separate intents. */
  refreshSequence?: number;
}): string {
  const mode = input.mode === "fill" ? "generate" : input.mode;
  const suffix = input.mode === "refresh" ? `:${input.refreshSequence ?? 0}` : "";
  return `${input.userId}:${input.recommendationId}:${mode}${suffix}`;
}

export type CachedRun = {
  status: "succeeded" | "failed" | "pending";
  contactsCreated: number;
  creditsSpent: number;
  /** When the cached set was written. */
  completedAt: Date | null;
  /** When the run row was inserted. Only read for pending rows, to tell an
   *  in-flight run from an abandoned one. */
  createdAt?: Date | null;
};

/**
 * How long a `pending` run may sit before it is treated as abandoned.
 *
 * Without this, one crash between the insert and the settle locks that firm
 * for that student FOREVER: the key is taken, the row never leaves pending,
 * and every later click joins a run that is not running. Five minutes is
 * comfortably longer than the slowest observed tier ladder and short enough
 * that a student who hits it once does not notice twice.
 *
 * The stale row is not deleted or reused - it is left exactly as it is, as
 * evidence - and the retry runs under a fresh key. Uncharged, because it
 * produced nothing.
 */
export const PENDING_STALE_MS = 5 * 60 * 1000;

export type ServeDecision =
  | { action: "serve_cached"; charge: 0; reason: "complete" | "partial" }
  | {
      action: "run";
      charge: "on_result";
      reason: "no_cache" | "failed_cache" | "refresh" | "fill" | "stale_pending";
    }
  | { action: "join_in_flight"; charge: 0; reason: "concurrent" };

/**
 * What to do with a click, given whatever run already exists for its key.
 */
export function decideServe(input: {
  mode: RequestMode;
  existing: CachedRun | null;
  now?: Date;
  staleAfterMs?: number;
}): ServeDecision {
  const { mode, existing } = input;
  const now = input.now ?? new Date();
  const staleAfterMs = input.staleAfterMs ?? PENDING_STALE_MS;

  if (existing?.status === "pending") {
    // Abandoned rather than in flight: something died between the insert and
    // the settle. Re-run under a fresh key rather than joining a ghost.
    const started = existing.createdAt ?? null;
    if (started && now.getTime() - started.getTime() > staleAfterMs) {
      return { action: "run", charge: "on_result", reason: "stale_pending" };
    }
    // Another press of the same intent is still in flight. Join it; do not
    // start a second run and do not charge twice.
    return { action: "join_in_flight", charge: 0, reason: "concurrent" };
  }

  // A refresh is a deliberate request for DIFFERENT people, so it always runs.
  if (mode === "refresh") return { action: "run", charge: "on_result", reason: "refresh" };

  // A fill tops up a partial set under the original run - never a new charge.
  //
  // Only when there IS such a set to complete. `mode` comes from the browser,
  // the fill key is deliberately the generate key, and creditsForOutcome
  // waives the charge for a fill - so an unconditional branch here let a
  // client ask for "fill" with no prior generate, or over and over, and get
  // provider runs that were never charged. A fill with nothing to top up is
  // not a completion; it falls through to the ordinary rules below, where a
  // first request is a chargeable generate and a complete set is served from
  // cache. Requires contacts to exist: a succeeded run that produced nobody
  // was never charged, so "completing" it would be free people.
  if (mode === "fill") {
    const partial =
      existing?.status === "succeeded" &&
      existing.contactsCreated > 0 &&
      existing.contactsCreated < 5;
    if (partial) return { action: "run", charge: "on_result", reason: "fill" };
  }

  if (!existing) return { action: "run", charge: "on_result", reason: "no_cache" };

  // A failure is not a cache. Re-running is the right answer, and the earlier
  // failure was never charged.
  if (existing.status === "failed") {
    return { action: "run", charge: "on_result", reason: "failed_cache" };
  }

  // A completed set - full or partial - is served as it stands. A partial one
  // is NOT silently topped up: that would charge for a click the student
  // thought was free. Filling it is an explicit action.
  return {
    action: "serve_cached",
    charge: 0,
    reason: existing.contactsCreated >= 5 ? "complete" : "partial",
  };
}

/**
 * What a finished run costs.
 *
 * Denominated in runs, as decided - not contacts. One run for any result that
 * produced at least one usable person; nothing at all otherwise.
 */
export function creditsForOutcome(input: {
  /**
   * The mode the run is CHARGED as, which is the one decideServe agreed to -
   * not the one the browser asked for. A request labelled "fill" that had no
   * partial run to complete is charged as the generate it actually is; see
   * chargeModeFor and its caller in lib/contact-sourcing-run.ts.
   */
  mode: RequestMode;
  contactsCreated: number;
  outcome: "succeeded" | "failed" | "identity_unresolved" | "provider_error";
}): 0 | 1 {
  if (input.outcome !== "succeeded") return 0;
  // A fill completes a run that was already paid for.
  if (input.mode === "fill") return 0;
  return input.contactsCreated > 0 ? 1 : 0;
}

/**
 * The mode a finished run is charged as.
 *
 * The browser supplies `mode`; only decideServe decides whether a "fill" was
 * really the free completion of a run already paid for. A fill it did not
 * agree to is charged as an ordinary generate, so the free path cannot be
 * claimed by asking for it.
 */
export function chargeModeFor(requested: RequestMode, decision: ServeDecision): RequestMode {
  if (decision.reason === "fill") return "fill";
  return requested === "fill" ? "generate" : requested;
}

/**
 * Whether the credit and the saved contacts may be committed.
 *
 * Both or neither. Charging before the write means a crash on the way home
 * leaves the student billed for contacts they never received; writing before
 * the charge means a crash loses the charge. One transaction, one decision.
 */
export function isChargeable(input: {
  contactsPersisted: boolean;
  credits: 0 | 1;
}): boolean {
  return input.credits === 1 && input.contactsPersisted;
}

/**
 * Whether a pending run has been abandoned.
 *
 * Shared with the allowance check, which must not count a ghost against a
 * student's monthly credits - see contact-credits.ts. Same clock, same
 * threshold, one definition.
 */
export function isStalePending(
  run: { status: string; createdAt?: Date | null },
  now: Date = new Date(),
  staleAfterMs: number = PENDING_STALE_MS,
): boolean {
  if (run.status !== "pending") return false;
  if (!run.createdAt) return false;
  return now.getTime() - run.createdAt.getTime() > staleAfterMs;
}
