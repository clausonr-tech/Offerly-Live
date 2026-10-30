/**
 * Loading the COMMITTED Form ADV fixture - strictly.
 *
 * The point of this file is the difference between two things that used to
 * look identical from the outside:
 *
 *   an optional 2.9MB extract is absent   -> that audit is unavailable, say so
 *   the committed fixture is absent        -> the suite is broken, FAIL
 *
 * Seven tests previously took the first branch for the second reason and
 * reported themselves as "skipped", which is how a clean checkout ran a green
 * suite that had never once exercised the loader. Everything here throws.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  indexByDomain,
  parseFirmBlocks,
  type AdvFirm,
  type FirmSize,
} from "../../../src/lib/monitoring/form-adv-parse";

export const FIXTURE_PATH = path.join(
  process.cwd(),
  "scripts",
  "test",
  "fixtures",
  "form-adv-sample.xml",
);

export class FixtureMissingError extends Error {
  constructor(file: string, cause: unknown) {
    super(
      `Committed Form ADV fixture missing or unreadable: ${file}. ` +
        "This file is checked in and is NOT the optional full extract - a " +
        "failure here means the repository is incomplete, not that an " +
        `optional input was skipped. (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = "FixtureMissingError";
  }
}

export class FixtureMalformedError extends Error {
  constructor(reason: string) {
    super(`Form ADV fixture is malformed: ${reason}`);
    this.name = "FixtureMalformedError";
  }
}

/** Raw fixture text. Throws rather than returning empty. */
export function readFixtureXml(file: string = FIXTURE_PATH): string {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new FixtureMissingError(file, error);
  }
  if (!raw.trim()) throw new FixtureMissingError(file, new Error("file is empty"));
  return raw;
}

/**
 * How many firm blocks the committed fixture is supposed to contain.
 *
 * Pinned, not derived. Without this a fixture that lost fourteen of its
 * fifteen blocks would still "parse fine", and every test over it would pass
 * while asserting nothing - the same failure mode as the skips, one layer
 * down.
 */
export const EXPECTED_FIXTURE_FIRMS = 15;

/**
 * Parse fixture text into firms, refusing anything that does not look like
 * the feed. Exported separately from the file read so a malformed-CONTENT
 * test can hand it a string without writing a broken file into the repo.
 */
export function parseFixture(xml: string, options: { expect?: number } = {}): AdvFirm[] {
  if (!/<Firm>/.test(xml)) {
    throw new FixtureMalformedError("no <Firm> blocks - not a Form ADV feed document");
  }
  const firms = parseFirmBlocks(xml);
  if (!firms.length) {
    throw new FixtureMalformedError("<Firm> blocks present but none carried a name");
  }
  const expect = options.expect;
  if (expect !== undefined && firms.length !== expect) {
    throw new FixtureMalformedError(`expected ${expect} named firms, parsed ${firms.length}`);
  }
  for (const firm of firms) {
    const bad = shapeProblem(firm);
    if (bad) throw new FixtureMalformedError(`${firm.name}: ${bad}`);
  }
  return firms;
}

/**
 * The shape the type promises, checked at runtime.
 *
 * Returns the problem rather than asserting, so the same rule can be used
 * both to validate the fixture on load and to assert over the full extract in
 * the optional audit - one definition of "correct shape", two callers.
 */
export function shapeProblem(firm: FirmSize & { domain?: string | null }): string | null {
  if (typeof firm.name !== "string" || !firm.name.length) return "name is empty";
  if (!(firm.crd === null || typeof firm.crd === "string")) return "crd is neither string nor null";
  if (!(firm.state === null || typeof firm.state === "string")) return "state is neither string nor null";
  if (firm.employees !== null && !Number.isFinite(firm.employees)) return "employees is not finite";
  if (firm.aum !== null && !Number.isFinite(firm.aum)) return "aum is not finite";
  if (firm.employees !== null && firm.employees < 0) return `employees is negative (${firm.employees})`;
  if (firm.aum !== null && firm.aum < 0) return `aum is negative (${firm.aum})`;
  if ("domain" in firm && !(firm.domain === null || typeof firm.domain === "string")) {
    return "domain is neither string nor null";
  }
  return null;
}

/** The fixture, parsed and validated. The entry point every test uses. */
export function loadFixtureFirms(): AdvFirm[] {
  return parseFixture(readFixtureXml(), { expect: EXPECTED_FIXTURE_FIRMS });
}

/** The fixture as the runtime would index it. */
export function loadFixtureIndex(): {
  index: Map<string, FirmSize>;
  collisions: { domain: string; kept: string; dropped: string }[];
} {
  return indexByDomain(loadFixtureFirms());
}

/** One firm by its business name, asserted present. Tests name their subject. */
export function firmNamed(firms: readonly AdvFirm[], name: string): AdvFirm {
  const found = firms.find((f) => f.name === name);
  if (!found) {
    throw new FixtureMalformedError(
      `fixture no longer contains "${name}" - the scenario it covered has been deleted, ` +
        `not fixed. Present: ${firms.map((f) => f.name).join(", ")}`,
    );
  }
  return found;
}
