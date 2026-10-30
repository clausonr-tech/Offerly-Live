// An upload that is not a resume gets no review (5 October 2026: an email was
// graded 63/100 for lacking an Education section). The first critic says what
// the file is; anything but a resume stops the review with a prompt to upload
// a resume instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DOCUMENT_KINDS, NotAResumeError, notAResume } from "@/lib/resume-review";

test("only a clear 'not a resume' stops the review", () => {
  assert.equal(notAResume("resume"), null);
  assert.equal(notAResume(undefined), null, "no answer is a failed call, not a verdict on the file");
  assert.equal(notAResume(null), null);
  for (const kind of DOCUMENT_KINDS.filter((k) => k !== "resume")) assert.equal(notAResume(kind), kind);
});

test("the student is told what the file looked like and what to do", () => {
  assert.match(new NotAResumeError("email").message, /reads like an email.*no feedback.*Upload your resume as a PDF and try again/);
  assert.match(new NotAResumeError("cover_letter").message, /a cover letter/);
  assert.match(new NotAResumeError("other").message, /something other than a resume/);
});

test("a rejected file is deleted and never adopted as the student's resume", () => {
  const src = readFileSync(path.join(process.cwd(), "src/app/(app)/outreach/resume-actions.ts"), "utf8");
  const branch = src.slice(src.indexOf("e instanceof NotAResumeError"));
  assert.match(branch.slice(0, 400), /deleteResumeFiles\(\[storedKey\]\)/);
  assert.match(branch.slice(0, 400), /notResume: true/);
  // adoptStoredResume runs only after a review exists, inside the try.
  assert.ok(src.indexOf("adoptStoredResume(userId") < src.indexOf("e instanceof NotAResumeError"));
});

test("the resume check is asked of every critic, so their requests stay identical but for the criterion", () => {
  const src = readFileSync(path.join(process.cwd(), "src/lib/resume-review.ts"), "utf8");
  assert.match(src, /const criticOutputSchema = z\.object\(\{\s*\/\*\*[^*]*\*\/\s*document_kind/);
  assert.match(src, /When in doubt, it is a resume/);
});
