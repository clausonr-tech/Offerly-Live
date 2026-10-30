// What a Dayforce posting becomes.
//
// Fixtures are cut from the real `POST /api/geo/{ns}/jobposting/search`
// response measured 19 September 2026 against Stockbridge and Realterm, then
// deformed on purpose. The deformations are not invented: every shape here is
// one this corpus has already produced somewhere - entity-encoded prose,
// tag-joined list items, absent locations, unparseable dates.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayforcePostingToListing,
  type DayforcePosting,
  type DayforceBoardRef,
} from "../../src/lib/monitoring/connectors/dayforce";

const REF: DayforceBoardRef = { namespace: "stockbridge", boardCode: "CANDIDATEPORTAL" };

/** The real Stockbridge posting, trimmed. */
const REAL: DayforcePosting = {
  jobPostingId: 743,
  jobReqId: 131,
  jobTitle: "Asset Management - Associate",
  jobDescription:
    "<p>Associate, Asset Management</p><p>San Francisco, CA</p><p>&nbsp;</p>" +
    "<p>This Asset Management role offers a unique opportunity to gain exposure " +
    "to industrial outdoor storage (IOS).</p>",
  postingStartTimestampUTC: "2026-08-24T07:00:00+00:00",
  postingExpiryTimestampUTC: null,
  postingLocations: [
    {
      formattedAddress:
        "Stockbridge San Francisco Office, 4 Embarcadero Center, San Francisco, California, United States of America",
      cityName: "San Francisco",
      stateCode: "CA",
      isoCountryCode: "US",
    },
  ],
};

const of = (patch: Partial<DayforcePosting>): DayforcePosting => ({ ...REAL, ...patch });

// --------------------------------------------------------------- the happy path

test("a real posting becomes a listing", () => {
  const listing = dayforcePostingToListing(REAL, REF);
  assert.ok(listing);
  assert.equal(listing.externalJobId, "743");
  assert.equal(listing.title, "Asset Management - Associate");
});

test("the id is the posting id, not the requisition id", () => {
  // Both are present and they differ (743 vs 131). The posting id is what the
  // detail URL uses, so it is the one that stays stable against our own links.
  assert.equal(dayforcePostingToListing(REAL, REF)?.externalJobId, "743");
});

test("a real id is what makes the quality gate able to verify this", () => {
  // posting-quality.ts separates "a record in a real system" from page
  // furniture by asking for an id from the source. Synthesising one here
  // would hand it a hash that reads as genuine - see the note in
  // monitor-run.ts on listingIdentityKey.
  const listing = dayforcePostingToListing(REAL, REF);
  assert.ok(listing?.externalJobId);
  assert.notEqual(listing.externalJobId.length, 64);
});

test("the listing URL points at the posting, not the board", () => {
  assert.equal(
    dayforcePostingToListing(REAL, REF)?.listingUrl,
    "https://jobs.dayforcehcm.com/en-US/stockbridge/CANDIDATEPORTAL/jobs/743",
  );
});

test("the application URL is the same page", () => {
  const listing = dayforcePostingToListing(REAL, REF);
  assert.equal(listing?.applicationUrl, listing?.listingUrl);
});

test("the listing URL is built on the permitted host, whatever the source URL was", () => {
  // Realterm was discovered at a us231 URL whose robots.txt disallows
  // everything. The link we store and show must not point back there.
  const listing = dayforcePostingToListing(REAL, {
    namespace: "Realterm",
    boardCode: "Candidateportal",
  });
  assert.ok(listing?.listingUrl.startsWith("https://jobs.dayforcehcm.com/"));
  assert.ok(!listing!.listingUrl.includes("us231"));
});

test("a tenant needing escaping is escaped into the URL", () => {
  const listing = dayforcePostingToListing(REAL, { namespace: "a b", boardCode: "c/d" });
  assert.ok(listing?.listingUrl.includes("a%20b"));
  assert.ok(listing!.listingUrl.includes("c%2Fd"));
});

// ------------------------------------------------------------------- locations

test("the city and state are the location, not the postal address", () => {
  // "Stockbridge San Francisco Office, 4 Embarcadero Center, San Francisco,
  // California, United States of America" as a location makes every posting
  // at one office look like a different place to dedup and the city matcher.
  assert.equal(dayforcePostingToListing(REAL, REF)?.location, "San Francisco, CA");
});

test("the country stands in when there is no state", () => {
  const listing = dayforcePostingToListing(
    of({ postingLocations: [{ cityName: "London", stateCode: null, isoCountryCode: "GB" }] }),
    REF,
  );
  assert.equal(listing?.location, "London, GB");
});

test("a city alone is a location", () => {
  const listing = dayforcePostingToListing(
    of({ postingLocations: [{ cityName: "Tokyo", stateCode: null, isoCountryCode: null }] }),
    REF,
  );
  assert.equal(listing?.location, "Tokyo");
});

test("the formatted address is the fallback, not the first choice", () => {
  const listing = dayforcePostingToListing(
    of({
      postingLocations: [
        { formattedAddress: "4 Embarcadero Center", cityName: null, stateCode: null, isoCountryCode: null },
      ],
    }),
    REF,
  );
  assert.equal(listing?.location, "4 Embarcadero Center");
});

test("no location at all is null, never an empty string", () => {
  // A "" location is a value the city matcher will try to match.
  for (const locations of [undefined, [], [{}]]) {
    const listing = dayforcePostingToListing(
      of({ postingLocations: locations as DayforcePosting["postingLocations"] }),
      REF,
    );
    assert.equal(listing?.location, null, JSON.stringify(locations));
  }
});

test("a whitespace-only city is not a location", () => {
  const listing = dayforcePostingToListing(
    of({ postingLocations: [{ cityName: "   ", stateCode: "  ", isoCountryCode: null }] }),
    REF,
  );
  assert.equal(listing?.location, null);
});

test("only the first location is read", () => {
  // Dayforce lists every office a requisition covers. Joining them makes one
  // unmatchable string; the first is the one the board itself shows.
  const listing = dayforcePostingToListing(
    of({
      postingLocations: [
        { cityName: "Dallas", stateCode: "TX" },
        { cityName: "Denver", stateCode: "CO" },
      ],
    }),
    REF,
  );
  assert.equal(listing?.location, "Dallas, TX");
});

// ----------------------------------------------------------------- description

test("HTML tags are stripped from the description", () => {
  const listing = dayforcePostingToListing(REAL, REF);
  assert.ok(!listing!.descriptionRaw.includes("<p>"));
  assert.ok(listing!.descriptionRaw.includes("industrial outdoor storage"));
});

test("tags become spaces, so adjacent list items stay separate words", () => {
  // <li>Intern</li><li>Analyst</li> collapsed without a space reads as
  // "InternAnalyst", which is neither word to the classifier.
  const listing = dayforcePostingToListing(
    of({ jobDescription: "<ul><li>Intern</li><li>Analyst</li></ul>" }),
    REF,
  );
  assert.ok(listing!.descriptionRaw.includes("Intern Analyst"));
});

const entities: [string, string][] = [
  ["&nbsp;", " "],
  ["&amp;", "&"],
  ["&rsquo;", "'"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&ndash;", "–"],
  ["&mdash;", "—"],
];
for (const [entity, decoded] of entities) {
  test(`the description decodes ${entity}`, () => {
    const listing = dayforcePostingToListing(
      of({ jobDescription: `Summer${entity}Analyst` }),
      REF,
    );
    assert.ok(
      listing!.descriptionRaw.includes(decoded.trim() || "Summer Analyst"),
      listing!.descriptionRaw,
    );
    assert.ok(!listing!.descriptionRaw.includes(entity));
  });
}

test("a double-encoded ampersand decodes one level, not two", () => {
  // "&amp;lt;" must become "&lt;" and not "<" - decoding the ampersand first
  // is the bug this ordering exists to avoid.
  const listing = dayforcePostingToListing(of({ jobDescription: "M&amp;amp;A" }), REF);
  assert.equal(listing?.descriptionRaw, "M&amp;A");
});

test("an absent description is an empty string, never undefined", () => {
  // Downstream calls .trim() on it unconditionally.
  for (const value of [undefined, null, ""]) {
    const listing = dayforcePostingToListing(
      of({ jobDescription: value as string | undefined }),
      REF,
    );
    assert.equal(listing?.descriptionRaw, "", JSON.stringify(value));
  }
});

test("runs of whitespace in the description collapse", () => {
  const listing = dayforcePostingToListing(
    of({ jobDescription: "Summer\n\n\t   Analyst" }),
    REF,
  );
  assert.equal(listing?.descriptionRaw, "Summer Analyst");
});

test("a script block's contents do not survive as text", () => {
  // The tag is stripped like any other, so its body would otherwise read as
  // prose. Not a security issue here - it is a classifier-noise issue.
  const listing = dayforcePostingToListing(
    of({ jobDescription: "<p>Real text</p><script>var intern = 1;</script>" }),
    REF,
  );
  assert.ok(listing!.descriptionRaw.includes("Real text"));
});

// ----------------------------------------------------------------------- dates

test("a stated start date becomes publishedAt, in ISO", () => {
  assert.equal(dayforcePostingToListing(REAL, REF)?.publishedAt, "2026-08-24T07:00:00.000Z");
});

test("a stated expiry becomes a real deadline", () => {
  // types.ts: deadlineAt is set only when the SOURCE states one.
  const listing = dayforcePostingToListing(
    of({ postingExpiryTimestampUTC: "2026-11-15T23:55:00+00:00" }),
    REF,
  );
  assert.equal(listing?.deadlineAt, "2026-11-15T23:55:00.000Z");
});

test("no expiry means no deadline, not a guessed one", () => {
  assert.equal(dayforcePostingToListing(REAL, REF)?.deadlineAt, null);
});

const badDates = ["", "  ", "not a date", "0000-00-00", "2026-13-45T00:00:00Z"];
for (const value of badDates) {
  test(`an unparseable date is dropped, not approximated: ${JSON.stringify(value)}`, () => {
    const listing = dayforcePostingToListing(
      of({ postingStartTimestampUTC: value, postingExpiryTimestampUTC: value }),
      REF,
    );
    assert.equal(listing?.publishedAt, null);
    assert.equal(listing?.deadlineAt, null);
  });
}

test("a date with no timezone still parses", () => {
  const listing = dayforcePostingToListing(of({ postingStartTimestampUTC: "2026-08-24" }), REF);
  assert.equal(listing?.publishedAt, "2026-08-24T00:00:00.000Z");
});

// ------------------------------------------------------------ refused postings

test("a posting with no title is not a listing", () => {
  for (const title of [undefined, "", "   "]) {
    assert.equal(
      dayforcePostingToListing(of({ jobTitle: title as string | undefined }), REF),
      null,
      JSON.stringify(title),
    );
  }
});

test("a posting with no id is not a listing", () => {
  // Without one there is nothing stable to dedup on, and the quality gate
  // cannot tell it from page furniture.
  for (const id of [undefined, null]) {
    assert.equal(
      dayforcePostingToListing(of({ jobPostingId: id as number | undefined }), REF),
      null,
      JSON.stringify(id),
    );
  }
});

test("posting id zero is a real id, not a missing one", () => {
  // `if (!id)` would drop this. Zero is falsy and still an id.
  const listing = dayforcePostingToListing(of({ jobPostingId: 0 }), REF);
  assert.ok(listing);
  assert.equal(listing.externalJobId, "0");
});

test("an empty object does not throw", () => {
  assert.doesNotThrow(() => dayforcePostingToListing({}, REF));
  assert.equal(dayforcePostingToListing({}, REF), null);
});

// ------------------------------------------------------------- title handling

test("the title's whitespace is normalised", () => {
  const listing = dayforcePostingToListing(of({ jobTitle: "  Summer\n\tAnalyst  " }), REF);
  assert.equal(listing?.title, "Summer Analyst");
});

test("the title decodes entities, so a student is not shown &amp;", () => {
  // Measured on Societe Generale, 18 Sep: "Corporate &amp; Investment banking"
  // went into the database verbatim.
  const listing = dayforcePostingToListing(
    of({ jobTitle: "Corporate &amp; Investment Banking Intern" }),
    REF,
  );
  assert.equal(listing?.title, "Corporate & Investment Banking Intern");
});

test("a non-breaking space in the title becomes a real space", () => {
  // A false positive on a software engineering role was traced to exactly
  // this, in the classifier robustness suite.
  const listing = dayforcePostingToListing(of({ jobTitle: "Summer Analyst" }), REF);
  assert.equal(listing?.title, "Summer Analyst");
});

test("a title is never HTML-stripped, only decoded", () => {
  // Titles are plain text in this API. Stripping tags from them would eat a
  // legitimate "<" in a title like "Analyst <2 years experience".
  const listing = dayforcePostingToListing(of({ jobTitle: "Analyst &lt;2 years" }), REF);
  assert.equal(listing?.title, "Analyst <2 years");
});

// -------------------------------------------------------- fields we never fill

test("employment type is left null rather than guessed from the title", () => {
  // The search response does not state one. classify.ts reads the title
  // itself; a field invented here would look like the board said it.
  assert.equal(dayforcePostingToListing(REAL, REF)?.employmentType, null);
});

test("division is left null rather than guessed", () => {
  assert.equal(dayforcePostingToListing(REAL, REF)?.division, null);
});
