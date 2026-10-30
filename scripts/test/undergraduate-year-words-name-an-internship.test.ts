/**
 * A title that names an undergraduate YEAR names an undergraduate programme.
 *
 * Found by measuring the 9,840 listings rejected because the title matched no
 * internship phrase - the stratum `TITLE_INTERNSHIP_PATTERN` is the sole
 * reason for, 57% of all rejections, and which had never been measured. Two
 * real programmes were sitting in it:
 *
 *   Weiss Asset Management  "2027 Underclassmen Fellowship"
 *   Bracebridge Capital     "2027 Sophomore Winternship"
 *
 * The Weiss posting is the sharper of the two: it is auto-approved and live to
 * students right now on a classification from an older crawl, and the current
 * rules rejected it - so the next re-classification would have retracted a
 * real internship. Measuring the rule is what surfaced it; nothing was failing.
 *
 * The keep-cases below are the reason this is three narrow words rather than a
 * general "sounds academic" rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TITLE_INTERNSHIP_PATTERN, classifyListing } from "../../src/lib/monitoring/classify";

test("the two real postings are recognised", () => {
  for (const title of ["2027 Underclassmen Fellowship", "2027 Sophomore Winternship"]) {
    assert.ok(TITLE_INTERNSHIP_PATTERN.test(title), title);
  }
});

test("the year words and the portmanteau, on their own", () => {
  for (const title of [
    "Underclassmen Program - Investment Banking",
    "Underclassman Insight Series",
    "Sophomore Summer Experience",
    "Freshman Discovery Programme",
    "Winternship - Corporate Finance",
  ]) {
    assert.ok(TITLE_INTERNSHIP_PATTERN.test(title), title);
  }
});

test("a fellowship or a scholar is NOT assumed to be an undergraduate", () => {
  /**
   * Both are in this corpus and neither is evidently an undergraduate
   * internship: Forbion's "Fellowship - Investment team" and Blockchain
   * Capital's "Research Scholar - 2026". A fellowship can be postdoctoral and
   * a scholar can be senior, so the words stay out and "Underclassmen
   * Fellowship" is caught by its first word instead.
   */
  assert.ok(
    !TITLE_INTERNSHIP_PATTERN.test("Fellowship - Investment team"),
    "a bare fellowship is not proof of an undergraduate programme",
  );
  assert.ok(
    !TITLE_INTERNSHIP_PATTERN.test("Research Scholar - 2026"),
    "a bare scholar is not proof of an undergraduate programme",
  );
});

test("the existing traps still hold, at the layer that holds them", () => {
  /**
   * Co-Op City is a Bronx neighbourhood and the phrase list carries "co-op",
   * so the RAW pattern does match this title - deliberately. The collision is
   * neutralised one layer up, in `normalizeForMatching`, which masks
   * "co-op city" to a placename before any phrase is tested. An earlier
   * version of this test asserted the pattern itself refused it and failed,
   * because it was checking the wrong layer for a guard that exists and works.
   *
   * So the assertion is on the behaviour, which is what anyone actually
   * depends on.
   */
  const c = classifyListing(
    {
      title: "Teller Part-Time (20 Hours) - Co-Op City Branch",
      descriptionRaw:
        "Hourly retail branch role in the Bronx. Greet customers, process " +
        "transactions and refer products. High school diploma or equivalent.",
      division: null,
      location: "Bronx, NY",
      employmentType: null,
      applicationUrl: null,
      listingUrl: "https://example.test/teller",
      publishedAt: null,
      deadlineAt: null,
    } as never,
    "commercial_banking" as never,
  );
  assert.equal(c.relevant, false, "an hourly teller job is not an internship, whatever the street is called");
});
