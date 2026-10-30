/**
 * The guard that stops the agent judging the wrong document.
 *
 * A listing URL that has gone dead usually does not 404 - it redirects to the
 * board index or serves a "this role is no longer available" page, and both
 * read as perfectly good text. Judging one of those judges the wrong page: a
 * board index full of OTHER internships could get a listing released on
 * somebody else's words, and a takedown page could get a real internship
 * denied.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { titleAppearsIn } from "@/lib/monitoring/page-identity";

test("a posting whose title survives the trip is accepted", () => {
  assert.equal(
    titleAppearsIn(
      "2027 Investment Banking Summer Analyst - Healthcare",
      "Join our Healthcare team. The 2027 Investment Banking Summer Analyst programme runs ten weeks.",
    ),
    true,
  );
});

test("reformatting does not break it", () => {
  // Boards change case, swap dashes, append a location or "(m/w/d)".
  assert.equal(
    titleAppearsIn(
      "Praktikant Digital Business, Marketing & Analytics (m/w/d)",
      "praktikant digital business marketing und analytics in hamburg - bewirb dich jetzt",
    ),
    true,
  );
});

test("a board index is rejected, even though it is full of internships", () => {
  // The failure that matters: this page would otherwise get a listing RELEASED
  // on a different posting's words.
  assert.equal(
    titleAppearsIn(
      "2027 Investment Banking Summer Analyst - Healthcare",
      "All our student opportunities: Summer Analyst Programme, Off-Cycle Internship, " +
        "Graduate Analyst Programme. Apply now to join our teams worldwide.",
    ),
    false,
    "a page with no trace of this posting was treated as this posting",
  );
});

test("a takedown page is rejected", () => {
  assert.equal(
    titleAppearsIn(
      "Quantitative Associate - Special District Group",
      "This position is no longer available. Please browse our current openings.",
    ),
    false,
  );
});

test("generic words alone are not evidence", () => {
  // Every posting carries "intern", "summer", "analyst" - matching on those
  // would accept any careers page as any posting.
  assert.equal(
    titleAppearsIn(
      "Summer Analyst Internship Programme",
      "Our summer analyst internship programme is open. Search roles.",
    ),
    true,
    "nothing distinctive to look for, so it must not block",
  );
  assert.equal(
    titleAppearsIn(
      "Healthcare Investment Banking Summer Analyst",
      "Our summer analyst internship programme is open. Search roles.",
    ),
    false,
    "matched a posting using only the words every posting shares",
  );
});

test("one distinctive word is not enough when two exist", () => {
  assert.equal(
    titleAppearsIn(
      "Restructuring Advisory Winter Internship Frankfurt",
      "Our Frankfurt office is hiring. Browse all openings.",
    ),
    false,
  );
});
