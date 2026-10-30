/**
 * The evaluator's hard cap on outbound provider requests.
 *
 * "Cases" (an item to transcribe, a transcript to grade) are the logical
 * units a run is estimated in. "Requests" are actual HTTP calls to a
 * provider - one case can cost several (a retry, a fallback model). The
 * budget counts REQUESTS, every one, and refuses to start one that would go
 * past the limit; the run then stops and reports what it completed.
 *
 * The evaluator's model calls are made with the SDK's own retries switched
 * off, so each attempt here is exactly one request and nothing is retried
 * out of sight (see live.ts).
 */

export class RequestLimitReached extends Error {
  constructor(readonly limit: number) {
    super(`Request limit of ${limit} reached; no further provider request was started.`);
    this.name = "RequestLimitReached";
  }
}

export type Provider = "transcription" | "anthropic";
type Tally = { attempted: number; succeeded: number; failed: number; retried: number; fallback: number };
const empty = (): Tally => ({ attempted: 0, succeeded: 0, failed: 0, retried: 0, fallback: 0 });

export class RequestBudget {
  private readonly tallies: Record<Provider, Tally> = { transcription: empty(), anthropic: empty() };
  /** Requests refused because they would have exceeded the limit. */
  refused = 0;

  constructor(readonly limit: number) {}

  get attempted(): number {
    return this.tallies.transcription.attempted + this.tallies.anthropic.attempted;
  }

  get exhausted(): boolean {
    return this.refused > 0;
  }

  /**
   * Claims one request before it is started. Throws RequestLimitReached -
   * and starts nothing - if it would exceed the limit. `kind` says whether
   * it is a first try, a retry of the same model, or a fallback model.
   */
  begin(provider: Provider, kind: "first" | "retry" | "fallback" = "first"): { ok: () => void; fail: () => void } {
    if (this.attempted + 1 > this.limit) {
      this.refused++;
      throw new RequestLimitReached(this.limit);
    }
    const t = this.tallies[provider];
    t.attempted++;
    if (kind === "retry") t.retried++;
    if (kind === "fallback") t.fallback++;
    let settled = false;
    return {
      ok: () => {
        if (settled) return;
        settled = true;
        t.succeeded++;
      },
      fail: () => {
        if (settled) return;
        settled = true;
        t.failed++;
      },
    };
  }

  /** A fetch that claims a request from this budget before each call. */
  countingFetch(provider: Provider, inner: typeof fetch = fetch): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const req = this.begin(provider);
      try {
        const res = await inner(input, init);
        if (res.ok) req.ok();
        else req.fail();
        return res;
      } catch (err) {
        req.fail();
        throw err;
      }
    }) as typeof fetch;
  }

  summary() {
    const total = empty();
    for (const t of Object.values(this.tallies)) for (const k of Object.keys(total) as (keyof Tally)[]) total[k] += t[k];
    return { limit: this.limit, ...total, refusedByLimit: this.refused, byProvider: { transcription: { ...this.tallies.transcription }, anthropic: { ...this.tallies.anthropic } } };
  }
}
