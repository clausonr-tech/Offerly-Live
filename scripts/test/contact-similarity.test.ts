import assert from "node:assert/strict";
import test from "node:test";

import { acronymFor, clubSignals, expandClub } from "@/lib/club-signals";
import { compareContact, rankContacts } from "@/lib/contact-similarity";

test("a full club name yields its acronym, an unknown acronym yields nothing", () => {
  // Safe direction: initials of a real name.
  assert.equal(acronymFor("Trojan Investing Society"), "TIS");
  // Unsafe direction: nothing tells us what "QRS" stands for.
  assert.deepEqual(expandClub("QRS"), ["QRS"]);
  // Two significant words make an acronym that collides with everything.
  assert.equal(acronymFor("Business Club"), null);
});

test("both spellings travel, however the student wrote it", () => {
  for (const written of ["Trojan Investing Society", "TIS", "Trojan Investing Society (TIS)"]) {
    const out = expandClub(written);
    assert.ok(out.includes("Trojan Investing Society"), `full name missing from "${written}"`);
    assert.ok(out.includes("TIS"), `acronym missing from "${written}"`);
  }
});

test("the same club from two sources is listed once", () => {
  const clubs = clubSignals({
    offerly: "Trojan Investing Society, Model United Nations",
    resume: ["Trojan Investing Society", "MUN"],
  });
  assert.equal(clubs.filter((c) => c === "Trojan Investing Society").length, 1);
  assert.equal(clubs.filter((c) => c === "MUN").length, 1);
  // The known expansion still arrives, from whichever side supplied the acronym.
  assert.ok(clubs.includes("Model United Nations"));
});

const student = {
  school: "University of Southern California",
  major: "Economics",
  hometown: "Boise, Idaho",
  clubs: ["Trojan Investing Society"],
  interests: ["Skiing", "Fishing"],
  priorEmployers: ["Evercore"],
};

test("the memo says what they share, strongest first", () => {
  const { memo, matches, score } = compareContact({
    student,
    contact: {
      name: "Maya Chen",
      school: "University of Southern California",
      clubs: ["TIS"],
      interests: ["skiing"],
      hometown: "Boise, ID",
    },
  });

  // The school still leads the MATCHES and still carries the most weight...
  assert.equal(matches[0].kind, "school");
  assert.ok(score > 0);
  // ...but it has its own column, so the memo spends its three slots on what
  // actually differs between two candidates at the same school.
  assert.ok(!memo.includes("Southern California"), memo);
  assert.equal(memo, "Both in TIS · Both from Boise · Also into skiing");
});

test("a club written as an acronym on one side still matches", () => {
  const { matches } = compareContact({
    student: { clubs: ["TIS"] },
    contact: { name: "Sam", clubs: ["Trojan Investing Society"] },
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, "club");
});

test("Boise, ID and Boise, Idaho are the same place", () => {
  const { matches } = compareContact({
    student: { hometown: "Boise, Idaho" },
    contact: { name: "Sam", hometown: "Boise, ID" },
  });
  assert.equal(matches[0]?.kind, "hometown");
});

test("nothing in common produces no memo, not an empty-sounding one", () => {
  const { matches, memo, score } = compareContact({
    student,
    contact: { name: "Stranger", school: "Yale University" },
  });
  assert.deepEqual(matches, []);
  assert.equal(memo, "");
  assert.equal(score, 0);
});

test("the contact with the most in common is offered first", () => {
  const ranked = rankContacts(student, [
    { name: "Only an interest", interests: ["Fishing"] },
    { name: "Same school and club", school: "University of Southern California", clubs: ["TIS"] },
    { name: "Same school", school: "University of Southern California" },
  ]);

  assert.deepEqual(
    ranked.map((r) => r.contact.name),
    ["Same school and club", "Same school", "Only an interest"],
  );
});

test("a nickname beats a derived acronym where one exists", () => {
  // Initials give "PKA", and the suffix would have given "PKAF". Neither is
  // what a member writes on their profile.
  const out = expandClub("Pi Kappa Alpha Fraternity");
  assert.ok(out.includes("Pike"), "the name people actually use is missing");
  // The initials are worth searching for too - just without the F.
  assert.ok(out.includes("PKA"), "the derived acronym was dropped");
  assert.ok(!out.includes("PKAF"), "the organisation-type suffix leaked into the acronym");
});

test("an organisation-type suffix does not change what a club is", () => {
  const { matches } = compareContact({
    student: { clubs: ["Pi Kappa Alpha Fraternity"] },
    contact: { name: "Sam", clubs: ["Pike"] },
  });
  assert.equal(matches[0]?.kind, "club");
});

test("a school written as a department still matches the university", () => {
  // Their filter returns these - "contains all words" - so our comparison has
  // to accept them too, or we drop the alumni we just paid to find.
  for (const theirs of [
    "University of Southern California - Marshall School of Business",
    "USC Marshall School of Business",
    "University of Southern California",
  ]) {
    const { matches } = compareContact({
      student: { school: "University of Southern California" },
      contact: { name: "Sam", schools: [theirs] },
    });
    assert.equal(matches[0]?.kind, "school", `missed: ${theirs}`);
    // Labelled with the name the student knows it by, not the department.
    assert.equal(matches[0]?.label, "University of Southern California");
  }
});

test("a different school is still a different school", () => {
  const { matches } = compareContact({
    student: { school: "University of Southern California" },
    contact: { name: "Sam", schools: ["University of Northern California"] },
  });
  assert.deepEqual(matches, []);
});

test("how close they were to being classmates carries the memo", () => {
  // Every result shares the school, because the search filters on it. What
  // separates a useful contact from a useless one is the year.
  const close = compareContact({
    student: { school: "USC", gradYear: 2028 },
    contact: { name: "Two years ahead", schools: ["USC"], gradYear: 2026 },
  });
  const distant = compareContact({
    student: { school: "USC", gradYear: 2028 },
    contact: { name: "A generation back", schools: ["USC"], gradYear: 2012 },
  });

  assert.ok(close.score > distant.score, "the nearer cohort must rank higher");
  // With the school out of the way, the cohort leads the line.
  assert.ok(close.memo.startsWith("Graduated 2 years ahead"), close.memo);
  assert.ok(!distant.matches.some((m) => m.kind === "cohort"), "16 years is not a cohort");
});

test("the same graduating year reads as that, not as zero years apart", () => {
  const { memo } = compareContact({
    student: { school: "USC", gradYear: 2027 },
    contact: { name: "Peer", schools: ["USC"], gradYear: 2027 },
  });
  assert.ok(memo.includes("Same graduating year"), memo);
});

test("studying in a city the student wants to work in counts", () => {
  const { matches } = compareContact({
    student: { targetCities: ["New York City"] },
    contact: { name: "Sam", schoolCities: ["New York"] },
  });
  assert.equal(matches[0]?.kind, "school_city");
});

test("working in a city the student is targeting is worth saying", () => {
  // The search filters on this, so every result has it - which means it never
  // changes the ranking. It still belongs in the memo: seeing that someone is
  // in the city you are trying to reach is the point of having targeted it.
  const { matches, memo } = compareContact({
    student: { targetCities: ["New York City"] },
    contact: { name: "Sam", currentCity: "New York" },
  });
  assert.equal(matches[0]?.kind, "city");
  assert.ok(memo.includes("Works in New York City"), memo);
});

test("a contact somewhere else is not a location match", () => {
  const { matches } = compareContact({
    student: { targetCities: ["New York City"] },
    contact: { name: "Sam", currentCity: "Chicago" },
  });
  assert.deepEqual(matches, []);
});


test("a contact who shares only the school gets no memo, because the column says it", () => {
  const { matches, memo, score } = compareContact({
    student: { school: "USC" },
    contact: { name: "Sam", schools: ["USC"] },
  });
  assert.equal(matches[0].kind, "school");
  assert.ok(score > 0, "the school still counts toward the ranking");
  assert.equal(memo, "", "but there is nothing left to say that the column does not");
});

test("a contact listing one of the school's exact names shares it, however LinkedIn spells it", () => {
  // Measured: a KKR analyst listing "University of Michigan - Stephen M. Ross
  // School of Business" beside NUS was labelled NUS - the nickname table could
  // not read the "Stephen M.", though the search had matched him on that name.
  const affinity = compareContact({
    student: {
      school: "University of Michigan",
      schoolNames: ["University of Michigan", "University of Michigan - Stephen M. Ross School of Business"],
    },
    contact: {
      name: "Simon Lin",
      schools: ["National University of Singapore", "University of Michigan - Stephen M. Ross School of Business"],
    } as never,
  });
  assert.ok(affinity.matches.some((m) => m.kind === "school" && m.label === "University of Michigan"));
});
