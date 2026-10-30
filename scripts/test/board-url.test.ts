// What may become a monitored source.
//
// The gate between board discovery and the crawler, and it had no tests. Every
// rule in it comes from a URL that was actually registered and then produced
// nothing: a Phenom widget's own JavaScript, a Workday login page, an Avature
// signup form, a link to one posting.
//
// It is also the most dangerous file in the crawl path to get wrong, because
// it does not merely ACCEPT a URL - it REWRITES one. A host check that lets a
// lookalike domain through here turns somebody else's domain into a real board
// address.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBoardUrl } from "../../src/lib/monitoring/board-url";
import { isHostOrSubdomainOf, vendorFor } from "../../src/lib/monitoring/vendor-host";

const ok = (raw: string) => {
  const r = normalizeBoardUrl(raw);
  assert.equal(r.ok, true, `expected ok for ${raw}: ${r.ok ? "" : r.reason}`);
  return r as Extract<typeof r, { ok: true }>;
};
const refused = (raw: string) => {
  const r = normalizeBoardUrl(raw);
  assert.equal(r.ok, false, `expected refusal for ${raw}`);
  return r as Extract<typeof r, { ok: false }>;
};

// ------------------------------------------------------------ the host guard

const vendors = ["greenhouse.io", "myworkdayjobs.com", "tal.net", "lever.co", "avature.net"];

for (const domain of vendors) {
  test(`the vendor itself matches: ${domain}`, () => {
    assert.equal(isHostOrSubdomainOf(domain, domain), true);
    assert.equal(isHostOrSubdomainOf(`boards.${domain}`, domain), true);
    assert.equal(isHostOrSubdomainOf(`a.b.${domain}`, domain), true);
  });

  test(`a lookalike does not: evil${domain}`, () => {
    // `evilgreenhouse.io`.endsWith("greenhouse.io") is true, which is the
    // trap this whole helper exists for.
    assert.equal(isHostOrSubdomainOf(`evil${domain}`, domain), false);
    assert.equal(isHostOrSubdomainOf(`${domain}.attacker.net`, domain), false);
  });
}

test("the host guard is case-insensitive and tolerates a trailing dot", () => {
  assert.equal(isHostOrSubdomainOf("BOARDS.GREENHOUSE.IO", "greenhouse.io"), true);
  assert.equal(isHostOrSubdomainOf("boards.greenhouse.io.", "greenhouse.io"), true);
});

test("the host guard refuses empty input rather than matching everything", () => {
  assert.equal(isHostOrSubdomainOf("", "greenhouse.io"), false);
  assert.equal(isHostOrSubdomainOf("boards.greenhouse.io", ""), false);
});

test("vendorFor returns the first matching domain", () => {
  assert.equal(vendorFor("jobs.lever.co", vendors), "lever.co");
  assert.equal(vendorFor("example.com", vendors), null);
});

const lookalikeBoards = [
  "https://evilgreenhouse.io/acme",
  "https://greenhouse.io.attacker.net/acme",
  "https://evilmyworkdayjobs.com/en-US/External",
  "https://eviltal.net/candidate/home",
  "https://evillever.co/acme",
  "https://evilavature.net/careers",
];
for (const raw of lookalikeBoards) {
  test(`a lookalike host is never rewritten into a real board: ${raw.slice(8, 44)}`, () => {
    // The dangerous case. `evillever.co/whatever` used to normalise to
    // `jobs.lever.co/whatever` - turning a domain somebody else owns into a
    // real board address of their choosing.
    const result = normalizeBoardUrl(raw);
    if (!result.ok) return; // refusing outright is also fine
    const host = new URL(result.url).hostname;
    for (const domain of vendors) {
      // isHostOrSubdomainOf, not endsWith - an assertion written the naive way
      // would trip on `evilgreenhouse.io` itself, which is the exact bug under
      // test. (It did, on the first run.)
      assert.ok(
        !isHostOrSubdomainOf(host, domain),
        `${raw} was rewritten onto the real ${domain}: ${result.url}`,
      );
    }
    // It should simply pass through as an ordinary careers page.
    assert.equal(host, new URL(raw).hostname, `${raw} had its host changed`);
  });
}

// --------------------------------------------------------- not a board at all

const assets = [
  "https://pp-cdn.phenompeople.com/CareerConnectResources/ph-search-results-v2-default-30.js",
  "https://acme.com/static/app.css",
  "https://acme.com/logo.png",
  "https://acme.com/fonts/x.woff2",
  "https://acme.com/data/jobs.json",
  "https://acme.com/bundle.js.map",
];
for (const raw of assets) {
  test(`a static asset is not a board: ${raw.slice(-28)}`, () => {
    // Discovery matched the Phenom pattern against RBC's page and returned the
    // widget's own JavaScript. It proves the firm runs Phenom and says nothing
    // about where their jobs are.
    assert.match(refused(raw).reason, /static asset|CDN host/);
  });
}

const cdnHosts = [
  "https://cdn.acme.com/careers",
  "https://assets.acme.com/careers",
  "https://static.acme.com/careers",
  "https://pp-cdn.acme.com/careers",
];
for (const raw of cdnHosts) {
  test(`a CDN host is not a board: ${raw.slice(8, 36)}`, () => {
    assert.match(refused(raw).reason, /CDN host/);
  });
}

const lateral = [
  "https://acme.com/careers/experienced-hires",
  "https://acme.com/careers/experienced_hire",
  "https://acme.com/lateral-opportunities",
  "https://acme.com/professional-hires",
  "https://acme.com/alumni-network",
];
for (const raw of lateral) {
  test(`an experienced-hire board is not a student one: ${raw.slice(17, 48)}`, () => {
    assert.match(refused(raw).reason, /experienced-hire|lateral/);
  });
}

const singlePostings = [
  "https://acme.com/job/12345",
  "https://acme.com/jobs/12345",
  "https://acme.com/careers/req_R123456",
  "https://acme.com/requisition/9876",
];
for (const raw of singlePostings) {
  test(`a single posting is not a board: ${raw.slice(17, 48)}`, () => {
    assert.match(refused(raw).reason, /one posting/);
  });
}

test("a malformed URL is refused, not thrown on", () => {
  for (const raw of ["", "not a url", "https://", "://x", "   "]) {
    assert.doesNotThrow(() => normalizeBoardUrl(raw));
    assert.equal(normalizeBoardUrl(raw).ok, false, JSON.stringify(raw));
  }
});

test("surrounding whitespace and entities are cleaned before parsing", () => {
  const result = ok("  https://boards.greenhouse.io/acme?a=1&amp;b=2  ");
  assert.match(result.url, /^https:\/\/boards\.greenhouse\.io\/acme/);
});

// ------------------------------------------------------------------ Workday

test("a Workday board is trimmed to tenant + site", () => {
  const result = ok("https://pjtpartners.wd1.myworkdayjobs.com/Students");
  assert.equal(result.url, "https://pjtpartners.wd1.myworkdayjobs.com/Students");
});

test("a Workday locale segment is preserved", () => {
  const result = ok("https://td.wd3.myworkdayjobs.com/en-US/TD_Bank_Careers");
  assert.equal(result.url, "https://td.wd3.myworkdayjobs.com/en-US/TD_Bank_Careers");
});

test("a Workday filter path is dropped and the drop is reported", () => {
  const result = ok("https://hl.wd1.myworkdayjobs.com/Campus/9/refreshFacet/318c8bb6f553100021d223d9780d30be");
  assert.equal(result.url, "https://hl.wd1.myworkdayjobs.com/Campus");
  assert.match(result.note ?? "", /trimmed to the board root/);
});

test("a Workday query string counts as something dropped", () => {
  const result = ok("https://cibc.wd3.myworkdayjobs.com/campus?q=intern");
  assert.equal(result.url, "https://cibc.wd3.myworkdayjobs.com/campus");
  assert.ok(result.note);
});

const workdayNonBoards = [
  "https://cibc.wd3.myworkdayjobs.com/search?q=intern",
  "https://acme.wd1.myworkdayjobs.com/job/Toronto/Analyst_R123",
  "https://acme.wd1.myworkdayjobs.com/",
  "https://acme.wd1.myworkdayjobs.com/en-US/",
  "https://acme.wd1.myworkdayjobs.com/login",
];
for (const raw of workdayNonBoards) {
  test(`a Workday non-board is refused: ${raw.slice(38, 76)}`, () => {
    assert.equal(normalizeBoardUrl(raw).ok, false, raw);
  });
}

test("a Workday board with no trailing path reports no note", () => {
  assert.equal(ok("https://pjtpartners.wd1.myworkdayjobs.com/Students").note, null);
});

// --------------------------------------------------------------- Greenhouse

test("a Greenhouse board root is kept", () => {
  assert.equal(ok("https://boards.greenhouse.io/acme").url, "https://boards.greenhouse.io/acme");
});

test("the newer Greenhouse host is kept as given", () => {
  assert.equal(
    ok("https://job-boards.greenhouse.io/acme").url,
    "https://job-boards.greenhouse.io/acme",
  );
});

test("a Greenhouse single posting is recovered to its board, not refused", () => {
  // The one exemption from the single-posting rule: the token is in the
  // segment before /jobs/, so the board is reconstructable. Nowhere else is.
  const result = ok("https://boards.greenhouse.io/acme/jobs/4567890");
  assert.equal(result.url, "https://boards.greenhouse.io/acme");
  assert.match(result.note ?? "", /trimmed/);
});

test("a Greenhouse embed widget is rebuilt from its ?for= token", () => {
  const result = ok("https://boards.greenhouse.io/embed/job_board?for=acmecampus");
  assert.equal(result.url, "https://boards.greenhouse.io/acmecampus");
  assert.match(result.note ?? "", /embed widget/);
});

const badForTokens = [
  "https://boards.greenhouse.io/embed/job_board?for=../../etc",
  "https://boards.greenhouse.io/embed/job_board?for=https://elsewhere.example",
  "https://boards.greenhouse.io/embed/job_board?for=a%2Fb",
  "https://boards.greenhouse.io/embed/job_board?for=",
  `https://boards.greenhouse.io/embed/job_board?for=${"x".repeat(200)}`,
];
for (const raw of badForTokens) {
  test(`a ?for= value that is not a token is refused: ${raw.slice(52, 88)}`, () => {
    // It came off a scraped page and was interpolated straight into a URL.
    const result = normalizeBoardUrl(raw);
    if (result.ok) {
      assert.match(result.url, /^https:\/\/boards\.greenhouse\.io\/[A-Za-z0-9._-]+$/, raw);
    }
  });
}

test("an /embed/ path without ?for= falls back to the second segment", () => {
  assert.equal(ok("https://boards.greenhouse.io/embed/acme").url, "https://boards.greenhouse.io/acme");
});

test("a Greenhouse URL with no token is refused", () => {
  assert.equal(normalizeBoardUrl("https://boards.greenhouse.io/").ok, false);
});

// --------------------------------------------------------------- TalentLink

test("a TalentLink job board path is kept", () => {
  const raw = "https://evercore.tal.net/vx/candidate/jobboard/vacancy/1/adv/";
  assert.equal(ok(raw).url, raw);
});

test("a TalentLink candidate/FAQ path is rewritten to the vacancy list", () => {
  // A careers page usually links at the FAQ or candidate home rather than the
  // advertised vacancy list.
  const result = ok("https://evercore.tal.net/candidate/faq");
  assert.equal(result.url, "https://evercore.tal.net/candidate/jobboard/vacancy/2/adv/");
  assert.match(result.note ?? "", /rewritten/);
});

// -------------------------------------------------------------------- Lever

test("a Lever board is trimmed to the company root", () => {
  assert.equal(ok("https://jobs.lever.co/acme/some-posting-uuid").url, "https://jobs.lever.co/acme");
});

test("a Lever URL with no company is refused", () => {
  assert.equal(normalizeBoardUrl("https://jobs.lever.co/").ok, false);
});

// ------------------------------------------------------------------ Avature

const avature = [
  "https://goldmansachs.avature.net/careers",
  "https://barclays.avature.net/GraduatesAndInterns",
  "https://williamblair.avature.net/students",
];
for (const raw of avature) {
  test(`an Avature portal is refused: ${raw.slice(8, 48)}`, () => {
    // Measured across this firm set: a login portal, a talent-pool signup form
    // titled "Let's keep in touch", and an empty body. A source registered
    // here would fetch cleanly forever and report zero listings, which is
    // indistinguishable from a board with no open roles.
    assert.match(refused(raw).reason, /Avature/);
  });
}

// ------------------------------------------------------------ everything else

test("an iCIMS board keeps its query string", () => {
  const raw = "https://careers-acme.icims.com/jobs/search?ss=1&searchCategory=8";
  assert.equal(ok(raw).url, raw);
});

test("an Oracle HCM board keeps its path", () => {
  const raw = "https://acme.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions";
  assert.equal(ok(raw).url, raw);
});

const accountPages = [
  "https://acme.com/careers/login",
  "https://acme.com/careers/signin",
  "https://acme.com/careers/register",
];
for (const raw of accountPages) {
  test(`a bare account path is refused: ${raw.slice(17)}`, () => {
    assert.equal(normalizeBoardUrl(raw).ok, false, raw);
  });
}

test("an account-looking segment with a query string is left alone", () => {
  // Eightfold and iCIMS carry meaningful query strings, so the account rule
  // only fires on a bare path.
  const raw = "https://acme.com/careers/search?keyword=intern";
  assert.equal(normalizeBoardUrl(raw).ok, true);
});

test("an ordinary careers page passes through unchanged", () => {
  const raw = "https://www.example.com/careers/students-and-graduates";
  assert.equal(ok(raw).url, raw);
});

test("http is accepted as well as https", () => {
  assert.equal(normalizeBoardUrl("http://www.example.com/careers").ok, true);
});

test("every refusal explains itself in words a person can act on", () => {
  for (const raw of [...assets, ...lateral, ...singlePostings, ...avature, "not a url"]) {
    const result = normalizeBoardUrl(raw);
    if (result.ok) continue;
    assert.ok(result.reason.length > 10, `"${result.reason}" for ${raw}`);
    assert.ok(!/undefined|null|\[object/.test(result.reason), result.reason);
  }
});

test("normalisation is idempotent", () => {
  // A URL that survived once must survive again unchanged, or re-running
  // discovery would keep rewriting the same source.
  for (const raw of [
    "https://boards.greenhouse.io/acme/jobs/123",
    "https://hl.wd1.myworkdayjobs.com/Campus/9/refreshFacet/abc",
    "https://jobs.lever.co/acme/uuid",
    "https://evercore.tal.net/candidate/faq",
  ]) {
    const once = normalizeBoardUrl(raw);
    assert.equal(once.ok, true, raw);
    const twice = normalizeBoardUrl((once as { url: string }).url);
    assert.equal(twice.ok, true, raw);
    assert.equal((twice as { url: string }).url, (once as { url: string }).url, raw);
  }
});
