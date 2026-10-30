/**
 * Fails the test run if anything reaches the network.
 *
 * Installed at the LOWEST shared boundary these modules have - global fetch.
 * Every Crustdata call in this codebase goes through it (company/identify,
 * person/search, person/contact/enrich), so patching here catches a live
 * request no matter which layer originates it, including one added later by
 * someone who has never read this file.
 *
 * It throws rather than returning a stub on purpose. A stubbed response would
 * let a test quietly pass while describing behaviour that never happened; an
 * exception makes the offending test fail loudly and name itself.
 *
 * The credentials are removed too. Blocking fetch stops the request, but a
 * test that reads process.env.CRUSTDATA_API_KEY and branches on its presence
 * would otherwise take the "we have a key" path and diverge from CI, where
 * there is none.
 */

const REAL_FETCH = globalThis.fetch;

export const LIVE_CALL_MESSAGE = "LIVE_CRUSTDATA_CALL_BLOCKED_IN_TEST";

let installed = false;

export function blockNetwork(): void {
  if (installed) return;
  installed = true;

  delete process.env.CRUSTDATA_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    throw new Error(`${LIVE_CALL_MESSAGE}: ${url}`);
  }) as typeof fetch;
}

/** Only for the guard's own test, which has to prove the block is real. */
export function restoreNetworkForGuardTestOnly(): void {
  globalThis.fetch = REAL_FETCH;
  installed = false;
}

blockNetwork();
