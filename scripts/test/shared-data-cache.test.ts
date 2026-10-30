// sharedCache (src/lib/shared-data-cache.ts): the shared firm, posting, news
// and question-bank queries must run outside a Next server too. Next's
// unstable_cache throws there ("incrementalCache missing"); on 30 September
// 2026 that failed every test and script reading those queries, and left five
// test files spinning instead of finishing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedCache } from "../../src/lib/shared-data-cache";

test("outside Next, a shared query runs uncached instead of throwing", async () => {
  let calls = 0;
  const double = sharedCache(async (x: number) => (calls++, x * 2), ["test-double-v1"], { revalidate: 60, tags: ["test"] });
  assert.equal(await double(21), 42);
  assert.equal(await double(4), 8);
  assert.equal(calls, 2, "no cache outside Next: each call runs the query");
});

test("any other error from the query still reaches the caller", async () => {
  const broken = sharedCache(async () => {
    throw new Error("database is down");
  }, ["test-broken-v1"], { revalidate: 60, tags: ["test"] });
  await assert.rejects(broken(), /database is down/);
});
