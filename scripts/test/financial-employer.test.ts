// Which portfolio companies count as financial institutions.
//
// This only matters for portfolio boards. Every other connector polls one
// employer's own board, so the employer is the firm the source belongs to and
// the question never comes up. A Getro board is a fund's whole portfolio -
// HV Capital's is 2,420 roles across 36 companies - and the rule is that a
// portfolio company is in scope only when it is itself financial.
//
// Every case below is taken from that real board, including the three wrong
// answers the first version gave.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyEmployer,
  isFinancialEmployer,
  normalizeEmployerName,
} from "../../src/lib/monitoring/financial-employer";

test('"Non-Financial" is not financial', () => {
  // The bug that started this: a substring test for "financial" matches the
  // tag "Other Services (B2C Non-Financial)", so a campervan rental company
  // and a veterinary service were both classified as financial institutions.
  // A rule that reads a tag saying NOT financial as financial is worse than
  // no rule at all.
  const roadsurfer = classifyEmployer("Roadsurfer", [
    "Automotive",
    "Car Rental",
    "Other Services (B2C Non-Financial)",
    "Travel & Tourism",
  ]);
  assert.equal(roadsurfer.financial, false);
});

test("one stray financial tag is not evidence", () => {
  // Holidu is a holiday-rentals marketplace tagged "Venture Capital" because
  // it is venture BACKED. Finn is a car subscription tagged "Financial
  // Services" because it does leasing. Both were admitted by a one-tag rule.
  const holidu = classifyEmployer("Holidu", [
    "Travel", "Hotels", "Vacation Rentals", "Search Engine", "Real Estate",
    "Hospitality", "Ecommerce", "Venture Capital",
  ]);
  assert.equal(holidu.financial, false);
  assert.match(holidu.reason, /only one financial tag/);
});

test("a fintech with an invented name is caught by its tags", () => {
  // Nothing about the strings "Qonto" or "Upvest" says bank, and both are.
  // This is the case no name-based rule can ever get right.
  assert.equal(isFinancialEmployer("Qonto", ["Banking", "Finance", "Financial Services"]), true);
  assert.equal(
    isFinancialEmployer("Upvest", ["Finance", "Financial Services", "Fintech", "Wealth Management"]),
    true,
  );
});

test("the fund's own postings are in scope", () => {
  // The most important single case: an "Investment Intern - Growth Stage" at
  // the fund that owns the board is exactly what this product is for, and the
  // first version dropped it.
  const hv = classifyEmployer("HV Capital", ["Finance", "Financial Services", "Venture Capital"]);
  assert.equal(hv.financial, true);
});

test("a logistics or aerospace company is out, whoever backed it", () => {
  assert.equal(isFinancialEmployer("FlixBus", ["Travel", "Public Transportation"]), false);
  assert.equal(isFinancialEmployer("Quantum-Systems", ["Aerospace", "Artificial Intelligence (AI)"]), false);
  assert.equal(isFinancialEmployer("jobvalley", ["Staffing Agency", "Recruiting"]), false);
});

test("insurance counts - it is a category in the directory", () => {
  assert.equal(isFinancialEmployer("ottonova", ["Insurance", "Insurtech", "Health Care"]), true);
});

test("with no tags, the firm directory can decide - but rarely does", () => {
  // The directory holds Form ADV LEGAL ENTITY names, not the names anyone
  // uses: "Blackstone Isg-i Advisors L.L.C." rather than "Blackstone". So an
  // exact match fires only when a job board happens to use the legal name,
  // which is uncommon. Kept because when it does fire it is certain, and
  // asserted honestly so nobody mistakes it for the main line of defence -
  // that is the industry tags.
  assert.equal(classifyEmployer("Blackstone Isg-i Advisors L.L.C.").financial, true);
  assert.equal(classifyEmployer("Blackstone").financial, false);
});

test("with no tags, only phrases identify a firm - never bare words", () => {
  // "Capital" alone is in half the startup names ever registered.
  assert.equal(isFinancialEmployer("Bolt Capital"), false);
  assert.equal(isFinancialEmployer("Meridian Capital Management"), true);
  assert.equal(isFinancialEmployer("Acme Securities"), true);
});

test("legal suffixes and punctuation do not create a second company", () => {
  assert.equal(normalizeEmployerName("Acme Capital, LLC"), normalizeEmployerName("Acme Capital"));
  assert.equal(normalizeEmployerName("feld.energy GMBH"), "feld energy");
});

test("an unnamed employer is never assumed to be in scope", () => {
  assert.equal(classifyEmployer("").financial, false);
});
