import assert from "node:assert/strict";
import test from "node:test";

import { ABOUT_ME_MAX, aboutFromLinkedIn, majorFromLinkedIn, majorFromResume } from "@/lib/profile-autofill";

const RESUME = [
  "EDUCATION",
  "- University of Pennsylvania · The Wharton School: BS in Economics, Concentrations in Finance and TBD",
  "- McCall-Donnelly High School · AP Calc AB, AP Bio, AP Lang",
  "",
  "WORK EXPERIENCE",
  "- Clauson Landscaping LLC · Founder & Owner · McCall, ID · May 2023 – Present",
].join("\n");

test("the major comes off the resume's degree line, concentrations kept, TBD dropped", () => {
  assert.equal(majorFromResume(RESUME), "Economics (Finance concentration)");
  assert.equal(majorFromResume("EDUCATION\n- USC · Bachelor of Science in Business Administration; GPA 3.9"), "Business Administration");
  assert.equal(majorFromResume("EDUCATION\n- NYU · B.A. in Mathematics and Economics"), "Mathematics and Economics");
  assert.equal(majorFromResume("EDUCATION\n- Some High School · AP Calc AB, AP Bio"), null, "an AP list is not a degree");
  assert.equal(majorFromResume("WORK EXPERIENCE\n- BS in Nothing"), null, "only the education section counts");
  assert.equal(majorFromResume(null), null);
});

const LINKEDIN = {
  headline: "University of Pennsylvania I Wharton Undergraduate",
  summary: null as string | null,
  education: [
    { school: "University of Pennsylvania", fieldOfStudy: "Finance", endYear: 2029 },
    { school: "The Wharton School", fieldOfStudy: "Finance and Entrepreneurship", endYear: 2029 },
    { school: "MCCALL-DONNELLY HIGH SCHOOL", fieldOfStudy: null, endYear: 2025 },
  ],
};

test("LinkedIn's field of study is taken from the student's own school", () => {
  assert.ok(["Finance", "Finance and Entrepreneurship"].includes(majorFromLinkedIn(LINKEDIN, "University of Pennsylvania")!));
  assert.equal(majorFromLinkedIn(LINKEDIN, "Stanford University"), null, "never another school's");
});

test("About me is their LinkedIn About, cut at a sentence to fit; else the headline", () => {
  assert.equal(aboutFromLinkedIn(LINKEDIN), "University of Pennsylvania I Wharton Undergraduate");
  const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} about me.`).join(" ");
  const about = aboutFromLinkedIn({ ...LINKEDIN, summary: long })!;
  assert.ok(about.length <= ABOUT_ME_MAX);
  assert.ok(about.endsWith("."), "cut at a sentence end");
});
