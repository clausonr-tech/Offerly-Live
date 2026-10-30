// Matching a firm to its SEC filing, by domain.
//
// The match is by DOMAIN and never by name, because both sides carry legal
// entity names that disagree on punctuation, suffix and which affiliate
// filed. That makes `domainOf` the whole join: every firm it normalises
// differently from the way the data file was built is a firm that silently
// reads as "not an SEC-registered adviser" - and enrollment then rejects it
// with "no Form ADV size data to judge by".
//
// A wrong answer here is invisible. It had no tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formAdvFilePresent,
  formAdvStatus,
  sizeForWebsite,
} from "../../src/lib/monitoring/form-adv";
import {
  domainOf,
  indexByDomain,
  isNotAFirmSite,
  parseFirmBlock,
  parseFirmBlocks,
  pickFirmWebsite,
  sizeIn,
} from "../../src/lib/monitoring/form-adv-parse";
import {
  EXPECTED_FIXTURE_FIRMS,
  FixtureMalformedError,
  FixtureMissingError,
  firmNamed,
  loadFixtureFirms,
  loadFixtureIndex,
  parseFixture,
  readFixtureXml,
  shapeProblem,
} from "./helpers/form-adv-fixture";

/**
 * NOTHING IN THIS FILE SKIPS.
 *
 * It used to. Seven tests asserted properties of scripts/data/form-adv-firms.json,
 * a 2.9MB extract that is gitignored and rebuilt from the SEC feed - so on a
 * clean checkout they threw ENOENT, and the fix at the time was to skip them
 * when the file was absent. That made the suite green, and it made every one of
 * those seven behaviours untested on every machine that had never run the
 * ingest script: the loader, the domain join, zero-AUM survival, the record
 * shape, the negative-value floor and the cache's immutability.
 *
 * They are replaced here by tests over a small committed fixture
 * (scripts/test/fixtures/form-adv-sample.xml), which exercises the same code
 * paths and always runs. Assertions that genuinely need the full extract - "is
 * the whole 22,000-firm directory sane" - live in scripts/test/full/, run by
 *
 *     npm run test:form-adv-full
 *
 * and are reported as one clearly-named optional audit below, never as silent
 * skips.
 */

// ----------------------------------------------------------- normalisation

const domains: [string, string | null][] = [
  // the plain cases
  ["example.com", "example.com"],
  ["https://example.com", "example.com"],
  ["http://example.com", "example.com"],
  ["https://example.com/", "example.com"],
  // www is stripped, in any case
  ["www.example.com", "example.com"],
  ["https://www.example.com", "example.com"],
  ["WWW.EXAMPLE.COM", "example.com"],
  ["HTTPS://WWW.Example.COM", "example.com"],
  // the host is lowercased
  ["Example.Com", "example.com"],
  ["https://EVERCORE.com", "evercore.com"],
  // paths, queries, fragments and ports are not part of the host
  ["https://example.com/careers", "example.com"],
  ["https://example.com/careers/internships?year=2027", "example.com"],
  ["https://example.com:8443/careers", "example.com"],
  ["https://example.com/#anchor", "example.com"],
  ["example.com/careers", "example.com"],
  // real shapes from the monitored sources
  ["https://morganstanley.tal.net/candidate/jobboard/vacancy/1/adv/", "morganstanley.tal.net"],
  ["https://boards.greenhouse.io/exampleco", "boards.greenhouse.io"],
  ["https://jobs.dayforcehcm.com/en-US/example/CANDIDATEPORTAL", "jobs.dayforcehcm.com"],
  ["https://example.wd1.myworkdayjobs.com/External", "example.wd1.myworkdayjobs.com"],
  // subdomains other than www are meaningful and kept
  ["careers.example.com", "careers.example.com"],
  ["https://www.careers.example.com", "careers.example.com"],
  ["uk.example.co.uk", "uk.example.co.uk"],
  // whitespace
  ["  example.com  ", "example.com"],
  ["\texample.com\n", "example.com"],
  // nothing
  ["", null],
  ["   ", null],
];
for (const [input, expected] of domains) {
  test(`domainOf ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
    assert.equal(domainOf(input), expected);
  });
}

for (const empty of [null, undefined]) {
  test(`domainOf(${empty}) is null`, () => {
    assert.equal(domainOf(empty), null);
  });
}

test("only one leading www is stripped", () => {
  // `www.www.example.com` is a real host and not the same as example.com.
  assert.equal(domainOf("www.www.example.com"), "www.example.com");
});

test("a host that merely starts with the letters www is left alone", () => {
  // The strip is anchored to `www.` - without the dot it would maul
  // wwwestern.com into estern.com.
  assert.equal(domainOf("wwwestern.com"), "wwwestern.com");
  assert.equal(domainOf("https://wwwestern.com"), "wwwestern.com");
});

test("a bare hostname is assumed to be https, not treated as a path", () => {
  // Without the scheme prefix, `new URL("example.com")` throws and every
  // firm stored without a protocol would go unmatched.
  assert.equal(domainOf("example.com"), "example.com");
});

const unparseable = ["http://", "https://", "://example.com", "not a url at all", "http:// ", "@@@"];
for (const bad of unparseable) {
  test(`unparseable input yields null rather than throwing: ${JSON.stringify(bad)}`, () => {
    assert.doesNotThrow(() => domainOf(bad));
    const got = domainOf(bad);
    assert.ok(got === null || typeof got === "string");
  });
}

test("domainOf never throws, whatever it is handed", () => {
  const inputs = ["", " ", "x".repeat(10_000), "https://" + "a".repeat(5000), "…", "🙂.com", "1.2.3.4", "[::1]"];
  for (const i of inputs) assert.doesNotThrow(() => domainOf(i), i);
});

test("an IP address is a valid host", () => {
  assert.equal(domainOf("http://1.2.3.4/careers"), "1.2.3.4");
});

test("normalisation is idempotent", () => {
  // The output must be a valid input, or re-normalising stored data drifts.
  for (const [input] of domains) {
    const once = domainOf(input);
    if (once === null) continue;
    assert.equal(domainOf(once), once, `${input} -> ${once} changed on second pass`);
  }
});

test("the same firm written five ways matches one domain", () => {
  const written = [
    "evercore.com",
    "www.evercore.com",
    "https://evercore.com",
    "https://www.evercore.com/",
    "HTTPS://WWW.EVERCORE.COM/careers/students",
  ];
  const got = new Set(written.map((w) => domainOf(w)));
  assert.equal(got.size, 1, `should all normalise together, got ${[...got].join(", ")}`);
});



// ======================================================================
//  THE COMMITTED FIXTURE
// ======================================================================
//
// scripts/test/fixtures/form-adv-sample.xml. Fifteen hand-written <Firm>
// blocks, one per scenario, with synthetic CRDs and figures. Every test below
// runs on a clean checkout with no ingest step and no network.

const fixture = loadFixtureFirms();
const { index: fixtureIndex, collisions } = loadFixtureIndex();

// ------------------------------------------------------------- parsing

test("the fixture parses to exactly the firms it declares", () => {
  assert.equal(fixture.length, EXPECTED_FIXTURE_FIRMS);
});

test("SEC field parsing: CRD, name, state, Item 5A headcount and Item 5F RAUM", () => {
  const evercore = firmNamed(fixture, "Evercore Inc.");
  assert.equal(evercore.crd, "900001");
  assert.equal(evercore.state, "NY");
  assert.equal(evercore.employees, 2100, "Item5A TtlEmp");
  assert.equal(evercore.aum, 12_000_000_000, "Item5F Q5F2C");
  assert.equal(evercore.domain, "evercore.com");
});

test("Q5F2C is read, not Q5F2A or Q5F2B", () => {
  // The block carries all three. C is the sum and the number everyone means
  // by AUM; taking A alone would understate this firm by a billion dollars.
  const evercore = firmNamed(fixture, "Evercore Inc.");
  assert.notEqual(evercore.aum, 11_000_000_000, "read Q5F2A (discretionary) by mistake");
  assert.notEqual(evercore.aum, 1_000_000_000, "read Q5F2B (non-discretionary) by mistake");
});

test("missing size fields are null, never zero", () => {
  // Null is unknown. Zero is small. An exempt reporting adviser that filed
  // neither item must not be read as managing nothing.
  const unstated = firmNamed(fixture, "Unstated Capital LLC");
  assert.equal(unstated.employees, null);
  assert.equal(unstated.aum, null);
});

test("zero AUM survives as zero", () => {
  // The scenario the skipped test covered, now on committed data. A pure
  // advisory firm manages nothing; read as unknown it floats over a size
  // floor it should fail.
  const cain = firmNamed(fixture, "Cain Brothers & Company, LLC");
  assert.equal(cain.aum, 0);
  assert.notEqual(cain.aum, null, "zero must not be coerced to unknown");
  const puresell = firmNamed(fixture, "Puresell Advisory Group LLC");
  assert.equal(puresell.aum, 0);
  assert.equal(puresell.employees, 18, "a firm with no AUM can still have staff");
});

test("the business name is preferred and the legal name is the fallback", () => {
  assert.ok(firmNamed(fixture, "Legalonly Holdings L.L.C."), "LegalNm-only firm was dropped");
});

test("a block with no name at all is dropped rather than given an empty one", () => {
  assert.ok(
    !fixture.some((f) => !f.name),
    "an unnamed firm would take a domain key and shadow a real one",
  );
  assert.ok(!fixtureIndex.has("nameless.example"));
});

test("a truncated block does not abort the parse of the rest", () => {
  // One throw here costs all 22,000 firms their size.
  const xml = readFixtureXml() + '\n<Firm><Info BusNm=';
  assert.doesNotThrow(() => parseFirmBlocks(xml));
  assert.equal(parseFirmBlocks(xml).length, EXPECTED_FIXTURE_FIRMS);
});

test("parseFirmBlock returns null rather than throwing on rubbish", () => {
  for (const junk of ["", "<Firm></Firm>", "<<<", "x".repeat(5000)]) {
    assert.doesNotThrow(() => parseFirmBlock(junk));
    assert.equal(parseFirmBlock(junk), null, JSON.stringify(junk.slice(0, 20)));
  }
});

// ------------------------------------------------- website normalisation

test("a normal corporate website normalises to its bare domain", () => {
  assert.equal(firmNamed(fixture, "Evercore Inc.").domain, "evercore.com");
});

test("a missing website is null, and the firm is still kept", () => {
  const quiet = firmNamed(fixture, "Quietwater Advisers LLC");
  assert.equal(quiet.domain, null);
  assert.equal(quiet.employees, 4, "size is still usable without a website");
});

test("a malformed website is null and never throws", () => {
  const bad = firmNamed(fixture, "Fatfinger Partners LP");
  assert.equal(bad.domain, null);
});

test("a nontraditional brand TLD survives: home.barclays", () => {
  // No dot-com, and `.barclays` is itself the public suffix. Anything that
  // assumes two labels, or strips a leading subdomain, breaks here.
  assert.equal(firmNamed(fixture, "Barclays Capital Inc.").domain, "home.barclays");
});

test("a careers subdomain is kept as itself", () => {
  // Kept on purpose: Form ADV is where SIZE comes from, and dropping the row
  // loses the headcount too. Whether careers.db.com may vouch for an EMAIL is
  // a separate question with a separate gate.
  assert.equal(firmNamed(fixture, "Deutsche Bank Securities Inc.").domain, "careers.db.com");
});

test("an ATS host is kept as itself, path and all stripped", () => {
  assert.equal(
    firmNamed(fixture, "Morgan Stanley Smith Barney LLC").domain,
    "morganstanley.tal.net",
  );
});

// --------------------------------------------------- blocklist behaviour

test("invalid-domain blocking: a LinkedIn COUNTRY subdomain is refused", () => {
  // ch.linkedin.com is the Swiss LinkedIn, not a Swiss firm. An exact-match
  // blocklist lets every country subdomain through; thirteen of them are in
  // the firm directory today because of exactly that.
  const alpen = firmNamed(fixture, "Alpenblick Capital AG");
  assert.equal(alpen.domain, null, "ch.linkedin.com was accepted as a firm website");
  assert.ok(isNotAFirmSite("ch.linkedin.com"));
  assert.ok(isNotAFirmSite("uk.linkedin.com"));
  assert.ok(isNotAFirmSite("linkedin.com"));
});

test("the blocked platforms never reach the index", () => {
  for (const host of ["linkedin.com", "ch.linkedin.com", "open.spotify.com", "spotify.com"]) {
    assert.ok(!fixtureIndex.has(host), `${host} is a key in the domain index`);
  }
});

test("a social address in the first slot does not become the firm's website", () => {
  // This is how Blue Owl Real Estate became linkedin.com: addresses[0].
  const second = firmNamed(fixture, "Secondslot Capital Management LLC");
  assert.equal(second.domain, "secondslot.example");
});

test("pickFirmWebsite walks past every platform before giving up", () => {
  assert.equal(
    pickFirmWebsite("<WebAddr>https://linkedin.com/x</WebAddr><WebAddr>https://real.example</WebAddr>"),
    "https://real.example",
  );
  assert.equal(pickFirmWebsite("<WebAddr>https://linkedin.com/x</WebAddr>"), null);
  assert.equal(pickFirmWebsite('<Info BusNm="No addresses"/>'), null);
});

test("a host that merely contains a blocked name is not blocked", () => {
  // The check is a dot-anchored suffix, not a substring: `.linkedin.com`.
  assert.ok(!isNotAFirmSite("linkedin-partners.example"));
  assert.ok(!isNotAFirmSite("notlinkedin.com"));
  assert.ok(!isNotAFirmSite(null));
});

// -------------------------------------------- duplicates and collisions

test("duplicate firms: the first record wins and the second is reported", () => {
  // The same CRD filed twice with different figures - an amended filing left
  // in the feed. Overwriting silently would make a firm's size depend on
  // parse order.
  const kept = sizeIn(fixtureIndex, "doubledadvisors.example");
  assert.ok(kept);
  assert.equal(kept.name, "Doubled Advisors LLC", "the amended row overwrote the original");
  assert.equal(kept.employees, 55);
  assert.ok(
    collisions.some((c) => c.domain === "doubledadvisors.example"),
    "the dropped duplicate was not reported",
  );
});

test("a parent and its subsidiary share one domain, and the collision is visible", () => {
  // key.com covers KeyCorp, KeyBank and Cain Brothers. There is no correct
  // single answer; what matters is that the index is deterministic and says
  // so, because a Cain Brothers banker on KeyBank's roster is the failure.
  const key = sizeIn(fixtureIndex, "key.com");
  assert.ok(key);
  assert.equal(key.name, "KeyCorp");
  const shared = collisions.find((c) => c.domain === "key.com");
  assert.ok(shared, "the subsidiary sharing key.com was not reported as a collision");
  assert.equal(shared.dropped, "Cain Brothers & Company, LLC");
});

test("a firm lost to a domain collision keeps its own record outside the index", () => {
  // The index drops it; the parsed list must not, or an audit cannot count
  // what was lost.
  assert.ok(firmNamed(fixture, "Cain Brothers & Company, LLC"));
});

test("indexing is deterministic across repeated builds", () => {
  const a = indexByDomain(fixture).index;
  const b = indexByDomain(fixture).index;
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
  for (const k of a.keys()) assert.deepEqual(a.get(k), b.get(k));
});

// ----------------------------------------------------------- the lookup

test("the join holds however the URL is written", () => {
  // THE property the whole file depends on. If adding `https://www.` loses
  // the match, every source stored with a full URL goes unsized.
  for (const firm of fixture) {
    if (!firm.domain) continue;
    const bare = sizeIn(fixtureIndex, firm.domain);
    assert.ok(bare, firm.domain);
    for (const variant of [
      `https://${firm.domain}`,
      `https://www.${firm.domain}`,
      `http://${firm.domain}/careers`,
      `  ${firm.domain.toUpperCase()}  `,
      `https://${firm.domain}:8443/x?y=1#z`,
    ]) {
      assert.deepEqual(sizeIn(fixtureIndex, variant), bare, `${variant} lost the match`);
    }
  }
});

test("an unknown firm is null, which means unknown and never small", () => {
  for (const unknown of [
    "definitely-not-a-registered-adviser-12345.com",
    "example.invalid",
    "",
    null,
    undefined,
  ]) {
    assert.equal(sizeIn(fixtureIndex, unknown), null, String(unknown));
    assert.equal(sizeForWebsite(unknown), null, String(unknown));
  }
});

test("lookups are repeatable, so nothing mutates what it returns", () => {
  for (const firm of fixture) {
    if (!firm.domain) continue;
    assert.deepEqual(sizeIn(fixtureIndex, firm.domain), sizeIn(fixtureIndex, firm.domain), firm.domain);
  }
});

test("sizeForWebsite never throws, with or without the optional extract", () => {
  for (const input of ["", " ", "://", "x".repeat(9000), "http://", null, undefined]) {
    assert.doesNotThrow(() => sizeForWebsite(input as string), String(input));
  }
});

// --------------------------------------------- the expected record shape

test("expected database shape: every fixture record matches the type", () => {
  for (const firm of fixture) {
    assert.equal(shapeProblem(firm), null, firm.name);
  }
});

test("sizes are never negative", () => {
  for (const firm of fixture) {
    if (firm.employees !== null) assert.ok(firm.employees >= 0, firm.name);
    if (firm.aum !== null) assert.ok(firm.aum >= 0, firm.name);
  }
});

test("formAdvStatus is stable across calls", () => {
  assert.deepEqual(formAdvStatus(), formAdvStatus());
});

// ======================================================================
//  THE OPTIONAL FULL-DATASET AUDIT - one named report, never a skip
// ======================================================================

test("optional full-dataset audit: availability is reported, not silently skipped", () => {
  const present = formAdvFilePresent();
  const status = formAdvStatus();

  if (present) {
    // Present means it must actually have loaded. A silent zero here is the
    // failure this codebase keeps paying for: every firm reads as unknown
    // size and enrollment rejects them all for the same wrong reason.
    assert.equal(status.error, null, `the extract is on disk but failed to load: ${status.error}`);
    assert.equal(status.loaded, true, "the extract is on disk but the index is empty");
    console.log(
      `  [optional audit] scripts/data/form-adv-firms.json present, ${status.firms} firms indexed. ` +
        "Run `npm run test:form-adv-full` for the full-dataset assertions.",
    );
    return;
  }

  // Absent is a legitimate state - it is gitignored and rebuilt from the SEC
  // feed - but it must be VISIBLE, and the runtime must degrade to "unknown
  // size" rather than pretending to a dataset it does not have.
  assert.equal(status.loaded, false);
  assert.ok(status.error, "a missing extract must be REPORTED, not left as a silent zero");
  assert.equal(sizeForWebsite("evercore.com"), null, "unknown, never small");
  console.log(
    "  [optional audit] UNAVAILABLE: scripts/data/form-adv-firms.json is not on disk. " +
      "Every test above ran against the committed fixture and is unaffected. To enable it: " +
      "`npx tsx --conditions=react-server scripts/ingest-form-adv.ts`, then " +
      "`npm run test:form-adv-full`.",
  );
});

// ======================================================================
//  PROVING THE SUITE STILL FAILS WHEN IT SHOULD
// ======================================================================
//
// The previous fix turned seven failures into seven skips. These exist so
// that cannot happen again quietly: they assert the fixture path FAILS on
// every condition a skip would have hidden.

test("a missing committed fixture FAILS - it is never treated as optional", () => {
  assert.throws(
    () => readFixtureXml("scripts/test/fixtures/this-file-does-not-exist.xml"),
    (e: unknown) => e instanceof FixtureMissingError,
  );
});

test("an empty committed fixture FAILS rather than parsing to nothing", () => {
  assert.throws(() => parseFixture("   "), (e: unknown) => e instanceof FixtureMalformedError);
});

test("malformed fixture content FAILS", () => {
  const cases: [string, string][] = [
    ["<html>not a feed</html>", "no <Firm> blocks"],
    ['<Firm><MainAddr State="NY"/></Firm>', "none carried a name"],
  ];
  for (const [xml, why] of cases) {
    assert.throws(
      () => parseFixture(xml),
      (e: unknown) => e instanceof FixtureMalformedError && e.message.includes(why),
      why,
    );
  }
});

test("a fixture that quietly loses blocks FAILS the count check", () => {
  // The subtler malformation: it still parses, so nothing throws on its own.
  // Without the pinned count, fourteen deleted scenarios would read as a
  // green suite asserting almost nothing.
  assert.throws(
    () => parseFixture('<Firm><Info BusNm="Only One"/></Firm>', { expect: EXPECTED_FIXTURE_FIRMS }),
    (e: unknown) => e instanceof FixtureMalformedError && /expected 15 named firms, parsed 1/.test(e.message),
  );
});

test("a fixture record of the wrong shape FAILS", () => {
  // Negative RAUM is the regression this catches: it parses as a number, so
  // only an explicit floor rejects it.
  assert.throws(
    () => parseFixture('<Firm><Info BusNm="Negative"/><Item5F Q5F2C="-5"/></Firm>'),
    (e: unknown) => e instanceof FixtureMalformedError && /aum is negative/.test(e.message),
  );
  assert.equal(
    shapeProblem({ crd: null, name: "", employees: null, aum: null, state: null }),
    "name is empty",
  );
});

test("a parser regression still fails the suite - the assertions are real", () => {
  // A canary. If someone makes `domainOf` a no-op, or empties the blocklist,
  // these are the shapes that stop being true - checked directly so the
  // guarantee does not rest on the tests above happening to notice.
  assert.notEqual(domainOf("https://www.evercore.com"), "https://www.evercore.com", "normalisation is a no-op");
  assert.equal(domainOf("https://www.evercore.com"), "evercore.com");
  assert.ok(isNotAFirmSite("ch.linkedin.com"), "the blocklist is empty");
  assert.equal(
    parseFirmBlock('<Firm><Info BusNm="X"/><Item5A TtlEmp="3"/></Firm>')?.employees,
    3,
    "attribute reading is broken",
  );
});
