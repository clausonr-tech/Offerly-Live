import assert from "node:assert/strict";
import test from "node:test";

import { hasScoreableProfile, rankPeerMatches, scorePeerMatch } from "@/lib/peer-match";
import type { DirectoryMember, SimilarityProfile } from "@/lib/people";

const viewer: SimilarityProfile = {
  schoolName: "University of Southern California",
  gradYear: 2029,
  preferredCategories: ["investment_banking"],
  nicheInterests: ["Leveraged Finance"],
  targetLocations: ["New York City"],
  topFirms: ["Goldman Sachs", "Evercore"],
};

function member(overrides: Partial<DirectoryMember> = {}): DirectoryMember {
  return {
    id: "m1",
    name: "A Student",
    schoolName: null,
    schoolDomain: null,
    gradYear: null,
    topFirms: [],
    preferredCategories: [],
    nicheInterests: [],
    targetLocations: [],
    isSample: false,
    ...overrides,
  };
}

test("every factor carries the same weight", () => {
  // One factor matched perfectly, five applicable and unmatched: one sixth.
  const schoolOnly = scorePeerMatch(
    viewer,
    member({ schoolName: "University of Southern California" }),
  );
  const firmsOnly = scorePeerMatch(viewer, member({ topFirms: ["Goldman Sachs", "Evercore"] }));
  const yearOnly = scorePeerMatch(viewer, member({ gradYear: 2029 }));

  assert.equal(schoolOnly.score, 17);
  assert.equal(firmsOnly.score, schoolOnly.score);
  assert.equal(yearOnly.score, schoolOnly.score);
});

test("sharing everything is 100 and sharing nothing is 0", () => {
  const twin = scorePeerMatch(
    viewer,
    member({
      schoolName: "University of Southern California",
      gradYear: 2029,
      topFirms: ["Goldman Sachs", "Evercore"],
      preferredCategories: ["investment_banking"],
      nicheInterests: ["Leveraged Finance"],
      targetLocations: ["New York City"],
    }),
  );
  assert.equal(twin.score, 100);

  const stranger = scorePeerMatch(
    viewer,
    member({ schoolName: "Yale University", gradYear: 2032, topFirms: ["KKR"] }),
  );
  assert.equal(stranger.score, 0);
});

test("overlap is measured against the shorter list, not the union", () => {
  // Both of the viewer's firms are shared. That the other student tracks ten
  // more does not make them less of a match from where the viewer stands -
  // Jaccard would score this 0.2 and rank a worse match above it.
  const wideNet = scorePeerMatch(
    viewer,
    member({
      topFirms: [
        "Goldman Sachs",
        "Evercore",
        "KKR",
        "Blackstone",
        "Lazard",
        "Moelis",
        "PJT Partners",
        "Centerview",
      ],
    }),
  );
  assert.equal(wideNet.factors.find((f) => f.key === "topFirms")?.score, 1);
});

test("a blank on the VIEWER's profile is excluded, not scored zero", () => {
  // Someone who has set nothing but a school still gets a real number out of
  // the one factor that can be compared, rather than being dragged to 17 by
  // five blanks that are the viewer's own doing.
  const sparse: SimilarityProfile = {
    schoolName: "University of Southern California",
    gradYear: null,
    preferredCategories: [],
    nicheInterests: [],
    targetLocations: [],
    topFirms: [],
  };
  const match = scorePeerMatch(
    sparse,
    member({ schoolName: "University of Southern California" }),
  );
  assert.equal(match.score, 100);
  assert.equal(match.factors.filter((f) => f.applicable).length, 1);
});

test("names are compared case- and whitespace-insensitively", () => {
  // The viewer's firms come from getTopFirmNames and a member's from
  // getTopFirmsFor - two queries, and this must not depend on them agreeing
  // on spacing.
  const match = scorePeerMatch(viewer, member({ topFirms: ["  goldman sachs ", "EVERCORE"] }));
  assert.equal(match.factors.find((f) => f.key === "topFirms")?.score, 1);
});

test("an adjacent graduating class is a half match, two years out is none", () => {
  assert.equal(scorePeerMatch(viewer, member({ gradYear: 2030 })).score, 8);
  assert.equal(scorePeerMatch(viewer, member({ gradYear: 2031 })).score, 0);
});

test("reasons name what was actually shared, strongest first", () => {
  const match = scorePeerMatch(
    viewer,
    member({
      schoolName: "University of Southern California",
      topFirms: ["Goldman Sachs", "KKR", "Blackstone", "Lazard"],
    }),
  );
  // School is a perfect 1; one firm of the viewer's two is 0.5.
  assert.deepEqual(match.reasons, [
    "Also at University of Southern California",
    "Also targeting Goldman Sachs",
  ]);
});

test("ranking is closest first and stable on ties", () => {
  const ranked = rankPeerMatches(viewer, [
    member({ id: "z", name: "Zoe", gradYear: 2029 }),
    member({ id: "a", name: "Ana", gradYear: 2029 }),
    member({
      id: "t",
      name: "Theo",
      schoolName: "University of Southern California",
      gradYear: 2029,
    }),
  ]);
  assert.deepEqual(
    ranked.map((r) => r.id),
    ["t", "a", "z"],
  );
});

test("an empty profile is reported as unscoreable rather than scored", () => {
  const blank: SimilarityProfile = {
    schoolName: null,
    gradYear: null,
    preferredCategories: [],
    nicheInterests: [],
    targetLocations: [],
    topFirms: [],
  };
  assert.equal(hasScoreableProfile(blank), false);
  assert.equal(hasScoreableProfile(viewer), true);
  assert.equal(scorePeerMatch(blank, member({ schoolName: "Yale University" })).score, 0);
});
