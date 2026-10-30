import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_CALL_MESSAGE,
  blockNetwork,
  restoreNetworkForGuardTestOnly,
} from "./helpers/no-network";

/**
 * The guard has to be proven, not assumed. A blocker that silently fails to
 * install is worse than none: every suite would report green while quietly
 * spending credits.
 */

test("any outbound fetch throws, whatever the URL", async () => {
  await assert.rejects(
    () => fetch("https://api.crustdata.com/company/identify"),
    (e: Error) => e.message.startsWith(LIVE_CALL_MESSAGE),
  );
  await assert.rejects(
    () => fetch("https://example.com/anything"),
    (e: Error) => e.message.startsWith(LIVE_CALL_MESSAGE),
  );
});

test("the blocked URL is named, so an offender identifies itself", async () => {
  await assert.rejects(
    () => fetch("https://api.crustdata.com/person/search"),
    (e: Error) => e.message.includes("api.crustdata.com/person/search"),
  );
});

test("provider credentials are removed from the environment", () => {
  assert.equal(process.env.CRUSTDATA_API_KEY, undefined);
});

test("the crustdata client cannot reach the network through the guard", async () => {
  // Through the real module, not a stand-in - this is the boundary that
  // matters. identifyCompanyCandidates catches its own errors and returns a
  // typed failure, which is itself the proof: it could not get out.
  const { identifyCompanyCandidates } = await import("@/lib/crustdata-client");
  const result = await identifyCompanyCandidates("Evercore", "evercore.com");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.lookedUpBy, "none");
  // No key in the environment, so it declines before it even tries.
  assert.equal(result.failure, "auth");
});

test("the guard can be reinstalled after being lifted", async () => {
  restoreNetworkForGuardTestOnly();
  blockNetwork();
  // fetch REJECTS; it does not throw synchronously. Awaiting the rejection is
  // the difference between asserting the guard and leaking an unhandled one.
  await assert.rejects(
    () => fetch("https://api.crustdata.com/x"),
    (e: Error) => e.message.startsWith(LIVE_CALL_MESSAGE),
  );
});
