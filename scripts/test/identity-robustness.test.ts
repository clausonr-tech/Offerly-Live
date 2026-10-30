// Do the identity and scoping functions hold up under real-world URL and name
// variation?
//
// board-identity decides whether two sources are one board, and listing
// identity decides whether two rows are one posting. Both are dedup keys, and
// a dedup key that changes under formatting either stops catching duplicates
// (the 353 rows it exists to prevent) or starts merging things that are not
// duplicates (which destroys real postings - the guard in
// audit-duplicate-listings.ts saved 59).
//
// Generated over every combination rather than hand-picked, because the
// failure is always the combination nobody thought to write down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupKey, listingDedupKey } from "../../src/lib/monitoring/board-identity";
import { candidateTokens } from "../../src/lib/monitoring/ats-probe";
import { classifyEmployer, normalizeEmployerName } from "../../src/lib/monitoring/financial-employer";

// ------------------------------------------------------------ board identity

/** Boards that are the same board however the URL is written. */
const BOARD_VARIANTS: { connector: string; urls: string[] }[] = [
  {
    connector: "workday",
    urls: [
      "https://stifel.wd5.myworkdayjobs.com/Stifel_External",
      "https://stifel.wd5.myworkdayjobs.com/Stifel_External/",
      "https://stifel.wd5.myworkdayjobs.com/en-US/Stifel_External",
      "https://stifel.wd5.myworkdayjobs.com/en-US/Stifel_External?workerSubType=Intern",
      "https://www.stifel.wd5.myworkdayjobs.com/Stifel_External",
      "https://stifel.wd5.myworkdayjobs.com/fr-FR/Stifel_External?q=analyst&page=2",
    ],
  },
  {
    connector: "greenhouse",
    urls: [
      "https://job-boards.greenhouse.io/acmecapital",
      "https://job-boards.greenhouse.io/acmecapital/",
      "https://boards.greenhouse.io/acmecapital",
      "https://job-boards.greenhouse.io/embed/job_board?for=acmecapital",
      "https://job-boards.greenhouse.io/acmecapital/jobs/12345",
    ],
  },
  {
    connector: "oracle-hcm",
    urls: [
      "https://x.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1003",
      "https://x.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1003/",
      "https://x.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/fr/sites/CX_1003",
    ],
  },
  {
    connector: "recruitee",
    urls: ["https://bcpartners.recruitee.com", "https://bcpartners.recruitee.com/", "https://bcpartners.recruitee.com/o/x"],
  },
];

for (const group of BOARD_VARIANTS) {
  test(`${group.connector}: every URL spelling is one board`, () => {
    const keys = group.urls.map((u) => dedupKey(u, group.connector));
    const distinct = new Set(keys);
    assert.equal(
      distinct.size,
      1,
      `${distinct.size} keys for one board:\n  ${group.urls.map((u, i) => `${keys[i]}  <- ${u}`).join("\n  ")}`,
    );
  });
}

test("different boards never collide", () => {
  // The opposite failure, and the more expensive one: merging two real boards
  // silently drops a firm's entire coverage.
  const distinct = [
    dedupKey("https://acme.wd1.myworkdayjobs.com/Campus", "workday"),
    dedupKey("https://acme.wd1.myworkdayjobs.com/Professionals", "workday"),
    dedupKey("https://other.wd1.myworkdayjobs.com/Campus", "workday"),
    dedupKey("https://job-boards.greenhouse.io/acme", "greenhouse"),
    dedupKey("https://job-boards.greenhouse.io/other", "greenhouse"),
    dedupKey("https://careers.example.com/ib", "generic"),
    dedupKey("https://careers.example.com/markets", "generic"),
  ];
  assert.equal(new Set(distinct).size, distinct.length, "two different boards produced the same key");
});

// ---------------------------------------------------------- listing identity

test("tracking parameters are not part of a posting's identity", () => {
  // A portfolio board appends its own attribution to the very same posting
  // URL - the exact case cross-board dedup exists for.
  const base = { title: "2027 Summer Analyst", firmId: "f1" };
  const keys = [
    "https://boards.greenhouse.io/acme/jobs/123",
    "https://boards.greenhouse.io/acme/jobs/123?gh_src=abcdef",
    "https://boards.greenhouse.io/acme/jobs/123?utm_source=getro&utm_medium=board",
    "https://www.boards.greenhouse.io/acme/jobs/123/",
  ].map((u) => listingDedupKey({ ...base, listingUrl: u }));
  assert.equal(new Set(keys).size, 1, `one posting produced ${new Set(keys).size} identities`);
});

test("two postings on one board stay two postings", () => {
  const base = { title: "2027 Summer Analyst", firmId: "f1" };
  const a = listingDedupKey({ ...base, listingUrl: "https://boards.greenhouse.io/acme/jobs/123" });
  const b = listingDedupKey({ ...base, listingUrl: "https://boards.greenhouse.io/acme/jobs/456" });
  assert.notEqual(a, b);
});

// ------------------------------------------------------------ probe tokens

test("token derivation never emits something unusable", () => {
  // These go straight into a URL. An empty, oversized or space-bearing token
  // is either a wasted request or a malformed one.
  const inputs: [string | null, string][] = [
    ["https://www.baincapital.com", "Bain Capital"],
    ["https://general-atlantic.com", "General Atlantic"],
    [null, "Blackstone"],
    ["not a url", "KKR & Co. Inc."],
    ["https://a.com", "A"],
    ["https://例え.jp", "Example KK"],
    ["https://firm.co.uk", "Firm LLP"],
    ["", "  Spaced   Name  "],
    ["https://x.com", ""],
  ];
  for (const [site, name] of inputs) {
    for (const token of candidateTokens(site, name)) {
      assert.match(token, /^[a-z0-9-]+$/, `token "${token}" is not URL-safe`);
      assert.ok(token.length >= 3 && token.length <= 40, `token "${token}" is the wrong length`);
      assert.equal(token, encodeURIComponent(token), `token "${token}" needs escaping`);
    }
  }
});

// -------------------------------------------------------- employer scoping

test("employer names normalise consistently", () => {
  // Getro's portfolio filter compares names, so a name that normalises two
  // ways is a company that is in scope half the time.
  const pairs: [string, string][] = [
    ["Acme Capital, LLC", "Acme Capital"],
    ["ACME CAPITAL LLC", "acme capital"],
    ["Acme  Capital", "Acme Capital"],
    ["Acme Capital L.L.C.", "Acme Capital"],
    ["Acme & Co", "Acme and"],
  ];
  for (const [a, b] of pairs) {
    assert.equal(normalizeEmployerName(a), normalizeEmployerName(b), `"${a}" and "${b}" normalise differently`);
  }
});

test("the financial-employer filter is stable under formatting", () => {
  // Same decision whatever case or spacing the fund's data uses.
  const variants = ["Scalable Capital", "SCALABLE CAPITAL", "  scalable   capital  "];
  const tags = ["Finance", "Investment Services"];
  const verdicts = variants.map((v) => classifyEmployer(v, tags).financial);
  assert.equal(new Set(verdicts).size, 1, "the same employer got different verdicts");
  assert.equal(verdicts[0], true);
});

test("a non-financial employer stays out however it is written", () => {
  for (const name of ["FlixBus", "FLIXBUS", "flixbus  "]) {
    assert.equal(classifyEmployer(name, ["Travel", "Public Transportation"]).financial, false);
  }
});
