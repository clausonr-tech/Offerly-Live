// The contract every connector has to keep, whatever vendor it speaks to.
//
// There are twenty-one of these and they are written months apart by whoever
// needed the next board. The interface is three lines long, so the ways to
// break it are not type errors - they are behavioural: a connector that
// throws instead of reporting, one that invents a listing out of a junk URL,
// one whose `id` does not match the string stored in the database, one that
// returns a shape the crawler then reads as an empty board.
//
// Every one of those failures looks identical afterwards: a source that reads
// healthy and produces nothing. That is the single largest category of gap in
// this crawler - 70 of 188 sources at the last count - so the contract is
// worth pinning rather than trusting.
//
// Deliberately NO NETWORK. Every case here uses URLs no connector can route
// to, so the assertions are about shape and safety rather than about whether
// a vendor happened to answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getConnector, detectConnector } from "../../src/lib/monitoring/connectors";
import type { SourceConnector } from "../../src/lib/monitoring/connectors/types";

// Every id registered in CONNECTORS, as stored in
// firm_monitoring_sources.connector_id.
const CONNECTOR_IDS = [
  "greenhouse", "talentlink", "workday", "oracle-hcm", "lever", "ashby",
  "smartrecruiters", "workable", "recruitee", "icims", "eightfold", "getro",
  "breezy", "bamboohr", "jobvite", "dayforce", "goldman", "baird", "kroll",
  "generic",
];

const connectors: [string, SourceConnector][] = CONNECTOR_IDS.map((id) => {
  try {
    return [id, getConnector(id)] as [string, SourceConnector];
  } catch {
    return [id, null as unknown as SourceConnector];
  }
});

// ------------------------------------------------------------- registration

for (const [id, connector] of connectors) {
  test(`${id}: is registered`, () => {
    assert.ok(connector, `getConnector("${id}") threw - the id in the database has no connector`);
  });

  test(`${id}: reports the id it was looked up by`, () => {
    // A mismatch here means a source stored under one id is polled by
    // another's logic, which is invisible until the board stops parsing.
    assert.equal(connector?.id, id);
  });

  test(`${id}: implements the interface`, () => {
    assert.equal(typeof connector?.canHandle, "function");
    assert.equal(typeof connector?.fetch, "function");
    if (connector?.enrich !== undefined) assert.equal(typeof connector.enrich, "function");
  });
}

test("an unknown connector id throws rather than silently falling back", () => {
  // Falling back to generic would turn a typo into a source that fetches the
  // wrong thing forever and reports success.
  assert.throws(() => getConnector("not-a-real-connector"));
});

// -------------------------------------------------------------- canHandle

const JUNK_URLS = [
  "",
  "   ",
  "not a url",
  "://",
  "http://",
  "javascript:alert(1)",
  "mailto:careers@example.com",
  "file:///etc/passwd",
  "https://",
  "https://example.com/careers",
  "https://evilgreenhouse.io/acme",
  "https://jobs.lever.co.attacker.net/acme",
];

for (const [id, connector] of connectors) {
  test(`${id}: canHandle never throws, whatever the URL`, () => {
    for (const careersUrl of JUNK_URLS) {
      assert.doesNotThrow(
        () => connector?.canHandle({ careersUrl, sourceType: "ats", lastEtag: null }),
        `${id} threw on ${JSON.stringify(careersUrl)}`,
      );
    }
  });

  test(`${id}: canHandle returns a boolean, not a truthy value`, () => {
    for (const careersUrl of JUNK_URLS) {
      const r = connector?.canHandle({ careersUrl, sourceType: "ats", lastEtag: null });
      assert.equal(typeof r, "boolean", `${id} returned ${typeof r} for ${careersUrl}`);
    }
  });
}

test("no specialist claims a lookalike host", () => {
  // `endsWith("greenhouse.io")` also accepts `evilgreenhouse.io`. A specialist
  // claiming one would send a firm's crawl to an attacker's board.
  for (const url of [
    "https://evilgreenhouse.io/acme",
    "https://jobs.lever.co.attacker.net/acme",
    "https://notashbyhq.com/acme",
    "https://myworkdayjobs.com.evil.net/acme",
  ]) {
    assert.equal(detectConnector(url).id, "generic", url);
  }
});

test("detectConnector always returns something and never throws", () => {
  for (const url of JUNK_URLS) {
    let picked: SourceConnector | null = null;
    assert.doesNotThrow(() => {
      picked = detectConnector(url);
    }, url);
    assert.ok(picked, url);
  }
});

// ------------------------------------------------------------------ fetch
//
// A connector handed a URL it cannot route to must REPORT that, not throw and
// not invent listings. monitor-run reads httpStatus 0 as "could not read",
// which is what stops decideClosure treating an empty result as a board that
// emptied.

const UNROUTABLE = "https://offerly-nonexistent-host.invalid/careers";

/**
 * Three connectors are pinned to ONE firm's board.
 *
 * `goldmanConnector.fetch()` takes no arguments at all - it ignores the
 * source and always reads Goldman's board, and baird and kroll are the same
 * shape. That is deliberate for a firm with a bespoke board, and it moves the
 * entire safety burden onto `canHandle`: if one of these is ever routed to a
 * different firm, that firm's crawl silently fills with Goldman's vacancies.
 *
 * So they are excluded from the URL-handling assertions below, which have no
 * meaning for a connector that reads no URL, and covered by their own test
 * instead. They are also not FETCHED here - calling them would reach out to
 * a real board, and this file makes no network requests.
 */
const FIRM_PINNED = new Set(["goldman", "baird", "kroll"]);

for (const [id, connector] of connectors) {
  if (!FIRM_PINNED.has(id)) continue;

  test(`${id}: is pinned to its own firm and claims nothing else`, () => {
    for (const url of [
      "https://example.com/careers",
      "https://job-boards.greenhouse.io/acme",
      "https://jobs.lever.co/acme",
      "not a url",
      "",
    ]) {
      assert.equal(
        connector.canHandle({ careersUrl: url, sourceType: "ats", lastEtag: null }),
        false,
        `${id} claimed ${JSON.stringify(url)} - it would attribute its own firm's jobs to another`,
      );
    }
  });

  test(`${id}: detectConnector never routes another firm's URL to it`, () => {
    for (const url of ["https://example.com/careers", "https://job-boards.greenhouse.io/acme"]) {
      assert.notEqual(detectConnector(url).id, id, url);
    }
  });
}

for (const [id, connector] of connectors) {
  // The generic connector launches a real browser, which is not this file's
  // business - connector-routing and generic-* cover it with fixtures. The
  // firm-pinned three read no URL and are covered above.
  if (id === "generic" || FIRM_PINNED.has(id)) continue;

  test(`${id}: fetch reports a junk URL instead of throwing`, async () => {
    // Junk that cannot parse as a URL, so no connector reaches the network.
    for (const careersUrl of ["", "not a url", "://"]) {
      let result;
      try {
        result = await connector.fetch({ careersUrl, sourceType: "ats", lastEtag: null });
      } catch (err) {
        assert.fail(`${id} threw on ${JSON.stringify(careersUrl)}: ${(err as Error).message}`);
      }
      assert.ok(Array.isArray(result.listings), `${id} returned no listings array`);
      assert.equal(typeof result.httpStatus, "number", `${id} returned no httpStatus`);
      assert.equal(typeof result.notModified, "boolean", `${id} returned no notModified`);
    }
  });

  test(`${id}: a URL it cannot route to yields no listings`, async () => {
    // Inventing a listing from an unroutable address would publish a posting
    // that does not exist.
    const result = await connector.fetch({ careersUrl: "not a url", sourceType: "ats", lastEtag: null });
    assert.equal(result.listings.length, 0, `${id} invented ${result.listings.length} listing(s)`);
  });
}

// ----------------------------------------------------------------- enrich
//
// Best-effort by contract: a listing whose detail page fails keeps whatever
// the index page gave it. A connector that blanked a description on failure
// would turn a thin listing into an unreviewable one.

const stub = {
  externalJobId: "req-1",
  title: "Summer Analyst Internship",
  division: null,
  location: "New York",
  descriptionRaw: "",
  employmentType: null,
  applicationUrl: UNROUTABLE,
  listingUrl: UNROUTABLE,
  publishedAt: null,
  deadlineAt: null,
};

for (const [id, connector] of connectors) {
  if (id === "generic" || FIRM_PINNED.has(id) || !connector?.enrich) continue;
  const enrich = connector.enrich.bind(connector);

  test(`${id}: enrich returns one listing per input, in order`, async () => {
    const out = await enrich([stub]);
    assert.ok(Array.isArray(out), `${id} returned no array`);
    assert.equal(out.length, 1, `${id} changed the listing count`);
    assert.equal(out[0].externalJobId, stub.externalJobId, `${id} reordered or replaced the listing`);
  });

  test(`${id}: enrich never throws on an unreachable detail page`, async () => {
    await assert.doesNotReject(() => enrich([stub]), `${id} threw`);
  });

  test(`${id}: a failed enrich keeps the stub rather than blanking it`, async () => {
    const withText = { ...stub, descriptionRaw: "A short existing description." };
    const out = await enrich([withText]);
    assert.ok(
      out[0].descriptionRaw.length >= withText.descriptionRaw.length,
      `${id} shortened or blanked an existing description`,
    );
  });

  test(`${id}: enrich on an empty list is an empty list`, async () => {
    const out = await enrich([]);
    assert.deepEqual(out, []);
  });
}
