/**
 * ONE live Crustdata request, to settle one remaining question.
 *
 * Does a person-search result carry a professional-profile URL, and at which
 * path? `fromCrustdataProfile` reads
 * `social_handles.professional_network_identifier.profile_url` and uses it as
 * `linkedinUrl` - which keys enrichment and is one of the two stable
 * identifiers deduplication trusts. It was never observed: the first probe's
 * output was truncated before that part of the payload.
 *
 * AUTHORIZED SCOPE, enforced by this script:
 *
 *   - exactly one HTTP request, to /person/search and nothing else
 *   - one company-id condition, limit 1, so at most one billable result
 *   - no retry, no fallback, no second search
 *   - no enrichment, no company resolution
 *   - nothing written to the database; no credits or run rows touched
 *   - maximum charge 0.03 credits
 *
 * PRINTS PATHS AND TYPES ONLY. No name, no profile URL, no email, no
 * education, no employment history - nothing that identifies the person whose
 * record happens to come back. A path is a fact about the API; a value is a
 * fact about a human being who did not ask to be in a transcript.
 *
 * Its own sentinel, separate from the first probe's: that one guards its own
 * authorization and must not be consumed or reset by this script.
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const ENDPOINT = "https://api.crustdata.com/person/search";
const API_VERSION = "2025-11-01";
const EVERCORE_COMPANY_ID = 682795;
const MAX_CREDITS = 0.03;

/** Distinct from scripts/.crustdata-shape-probe-sent, which belongs to the
 *  first authorization and is neither read nor written here. */
const SENTINEL = path.join(process.cwd(), "scripts", ".crustdata-profile-url-probe-sent");

const BODY = {
  filters: {
    op: "and",
    conditions: [
      {
        field: "experience.employment_details.current.company_id",
        type: "=",
        value: EVERCORE_COMPANY_ID,
      },
    ],
  },
  limit: 1,
} as const;

/** Anything that might carry a profile URL, by key name. */
const URLISH_KEY = /(^|_)(url|permalink|handle|urn|identifier|profile)($|_)/i;
/** A value that looks like a person's profile link. Matched, never printed. */
const PERSON_PROFILE_VALUE = /linkedin\.com\/in\/|\/in\/[A-Za-z0-9-]|urn:li:(fs_)?(person|profile|member)/i;

type Finding = { path: string; type: string; looksLikePersonProfile: boolean };

function walk(value: unknown, prefix: string, out: Finding[], depth = 0): void {
  if (depth > 10 || value === undefined) return;
  if (value === null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${prefix}[${i === 0 ? "0" : i}]`, out, depth + 1));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
    return;
  }
  const key = prefix.split(".").pop() ?? "";
  const isString = typeof value === "string";
  const looksLikePersonProfile = isString && PERSON_PROFILE_VALUE.test(value);
  if (URLISH_KEY.test(key) || looksLikePersonProfile) {
    out.push({ path: prefix, type: typeof value, looksLikePersonProfile });
  }
}

/** Does a dotted path exist on the object, and what type is it? */
function at(root: unknown, dotted: string): { exists: boolean; type: string } {
  let current: unknown = root;
  for (const segment of dotted.split(".")) {
    if (current === null || typeof current !== "object" || !(segment in (current as object))) {
      return { exists: false, type: "absent" };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: current !== undefined, type: current === null ? "null" : typeof current };
}

async function main() {
  if (existsSync(SENTINEL)) {
    throw new Error(
      `This probe has already been sent (${SENTINEL} exists). ` +
        "The authorization was for exactly one request.",
    );
  }
  const apiKey = process.env.CRUSTDATA_API_KEY?.trim();
  if (!apiKey) throw new Error("CRUSTDATA_API_KEY is not set.");

  if (BODY.limit !== 1) throw new Error("limit must be 1 - more than one result would be billable");
  if (BODY.filters.conditions.length !== 1) throw new Error("exactly one condition is authorized");

  console.log("request  POST", ENDPOINT);
  console.log("body    ", JSON.stringify(BODY));
  console.log(`budget   max ${MAX_CREDITS} credits\n`);

  writeFileSync(SENTINEL, `${new Date().toISOString()}\n${JSON.stringify(BODY)}\n`);

  // ONE fetch. No retry, no fallback.
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "x-api-version": API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(BODY),
    signal: AbortSignal.timeout(30_000),
  });

  const credits = response.headers.get("x-credits-used");
  console.log(`status   ${response.status} ${response.statusText}`);
  console.log(`x-credits-used: ${credits ?? "(absent)"}`);

  if (!response.ok) {
    console.log("\nNot ok. Stopping - no retry, no second request.");
    return;
  }

  const payload = (await response.json()) as { profiles?: unknown[] };
  const profiles = payload.profiles ?? [];
  console.log(`results  ${profiles.length} profile(s)`);
  if (!profiles.length) {
    console.log("No profile returned - nothing to inspect. Stopping.");
    return;
  }

  const profile = profiles[0];

  const handles = at(profile, "social_handles");
  const identifier = at(profile, "social_handles.professional_network_identifier");
  const profileUrl = at(profile, "social_handles.professional_network_identifier.profile_url");
  const urnUrl = at(profile, "social_handles.professional_network_identifier.urn_url");

  const findings: Finding[] = [];
  walk(profile, "", findings);
  const known = new Set([
    "social_handles.professional_network_identifier.profile_url",
    "social_handles.professional_network_identifier.urn_url",
  ]);

  const report = {
    has_social_handles: handles.exists,
    has_professional_network_identifier: identifier.exists,
    has_profile_url: profileUrl.exists,
    profile_url_type: profileUrl.type,
    has_urn_url: urnUrl.exists,
    urn_url_type: urnUrl.type,
    alternative_profile_paths: findings
      .filter((f) => !known.has(f.path))
      .map((f) => ({ path: f.path, type: f.type, looks_like_person_profile: f.looksLikePersonProfile })),
  };

  console.log("\n--- sanitized schema report (paths and types only) ---");
  console.log(JSON.stringify(report, null, 2));

  if (identifier.exists) {
    const keys = Object.keys(
      ((profile as Record<string, unknown>).social_handles as Record<string, unknown>)
        .professional_network_identifier as object,
    );
    console.log(`\nprofessional_network_identifier keys: ${keys.join(", ")}`);
  }
  if (handles.exists) {
    console.log(`social_handles keys: ${Object.keys((profile as Record<string, unknown>).social_handles as object).join(", ")}`);
  }
  console.log(`top-level profile keys: ${Object.keys(profile as object).join(", ")}`);

  console.log("\nNothing persisted. No enrichment, no resolution, no retry, no second request.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`PROBE FAILED: ${err instanceof Error ? err.message : err}`);
    console.error("No retry will be attempted.");
    process.exit(1);
  },
);
