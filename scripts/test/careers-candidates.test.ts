/**
 * Where enrolment looks for a board, and where it must not.
 *
 * Coverage is the crawler's largest gap: 22,554 firms in the directory, 4,995
 * watched, 85 with a live posting. 319 of the 351 sources that have never
 * answered are bare apex URLs - what enrolment produces when it finds no
 * board - and many real boards are not on a path at all. Kroll's is
 * `careers.kroll.com`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { careersCandidates } from "@/lib/monitoring/careers-candidates";

test("it tries the firm's own paths and its own subdomains", () => {
  const got = careersCandidates("https://kroll.com");
  assert.ok(got.includes("https://kroll.com/careers"), "the conventional path is gone");
  assert.ok(
    got.includes("https://careers.kroll.com/"),
    "careers.kroll.com - the exact board this gap was named for - is not tried",
  );
  assert.ok(got.includes("https://jobs.kroll.com/"));
});

test("the apex root is never a candidate, the subdomain root always is", () => {
  const got = careersCandidates("https://firm.com");
  /**
   * The asymmetry that matters: `https://firm.com/` is a homepage, and
   * enrolling one is this script's named failure - 319 sources are in exactly
   * that state. `https://careers.firm.com/` IS the board.
   */
  assert.ok(!got.includes("https://firm.com/"), "the apex homepage became a candidate");
  assert.ok(!got.includes("https://firm.com"), "the apex homepage became a candidate");
  assert.ok(got.includes("https://careers.firm.com/"));
});

test("no candidate is ever on a host the firm does not control", () => {
  /**
   * The failure this guards is the one retracted on 12 October 2026: 64
   * postings published under four venture firms' names because a Getro
   * PORTFOLIO board was read as the firm's own - 55 of them Munich Re's jobs
   * under "Group 11". A slug guessed onto an ATS host does the same thing:
   * `boards.greenhouse.io/capital` belongs to whoever registered it.
   *
   * Everything here must be the firm's own domain, so attribution is correct
   * by construction rather than by luck.
   */
  for (const site of ["https://kroll.com", "https://blackstone.com", "example.co.uk"]) {
    for (const url of careersCandidates(site)) {
      const host = new URL(url).hostname;
      const own = new URL(site.startsWith("http") ? site : `https://${site}`).hostname.replace(
        /^www\./i,
        "",
      );
      assert.ok(
        host === own || host.endsWith(`.${own}`),
        `${url} is not on the firm's own domain (${own})`,
      );
      for (const ats of ["greenhouse.io", "lever.co", "getro.com", "workable.com", "ashbyhq.com"]) {
        assert.ok(!host.endsWith(ats), `${url} guesses a slug on a third-party ATS host`);
      }
    }
  }
});

test("www is stripped, and an already-careers host is not doubled", () => {
  assert.ok(careersCandidates("https://www.firm.com").includes("https://careers.firm.com/"));
  const already = careersCandidates("https://careers.firm.com");
  assert.ok(
    !already.some((u) => new URL(u).hostname === "careers.careers.firm.com"),
    "stacked the subdomain onto a host that already had it",
  );
});

test("an unusable website yields nothing rather than throwing", () => {
  assert.deepEqual(careersCandidates("not a url at all ::::"), []);
  assert.deepEqual(careersCandidates(""), []);
});
