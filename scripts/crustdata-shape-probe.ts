/**
 * ONE live Crustdata request, to settle one question.
 *
 * Does a person-search result actually carry a stable company identifier on
 * current employment - `company_id`, `companyId`, or something else?
 *
 * That field is the whole employment gate. `confirmEmployment` fails closed
 * without it, which means contact generation currently returns NOBODY if the
 * response shape differs from what the filter grammar implies. The path was
 * inferred from the filter constants the API accepts, never read off a real
 * payload, because no captured response exists in this repository.
 *
 * AUTHORIZED SCOPE, and the script enforces every line of it itself:
 *
 *   - exactly one HTTP request, to /person/search and nothing else
 *   - one company-id condition, limit 1, so at most one billable result
 *   - no retry, no fallback, no second search
 *   - no enrichment, no company resolution
 *   - nothing written to the database, no credits or run rows touched
 *   - nobody returned is persisted, rendered, or shown to a user
 *   - maximum charge 0.03 credits (0.03 per result returned)
 *
 * It refuses to run twice: a sentinel file is written before the request is
 * sent, so a re-run - or a crash mid-flight followed by a re-run - cannot
 * quietly buy a second one.
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { fromCrustdataProfile } from "@/lib/crustdata-client";
import { confirmEmployment, parseEmploymentEvidence } from "@/lib/employment";

const ENDPOINT = "https://api.crustdata.com/person/search";
const API_VERSION = "2025-11-01";
const EVERCORE_COMPANY_ID = 682795;
const MAX_CREDITS = 0.03;
const SENTINEL = path.join(process.cwd(), "scripts", ".crustdata-shape-probe-sent");

/** The body. Built here rather than through toCrustdataRequest, because that
 *  path calls resolveCompany first - which is a second HTTP request. */
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

/** Paths and types only. No values, so nobody's details reach a transcript. */
function shape(value: unknown, prefix = "", out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (value === null) {
    out.push(`${prefix}: null`);
  } else if (Array.isArray(value)) {
    out.push(`${prefix}[]: array(${value.length})`);
    if (value.length) shape(value[0], `${prefix}[0]`, out, depth + 1);
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      shape(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  } else {
    out.push(`${prefix}: ${typeof value}`);
  }
  return out;
}

/** Only fields that are not about a person may have their value printed. */
const SAFE_TO_PRINT = new Set(["company_id", "companyId", "start_date", "end_date", "company_name"]);

async function main() {
  if (existsSync(SENTINEL)) {
    throw new Error(
      `A request has already been sent (${SENTINEL} exists). ` +
        "The authorization was for exactly one; delete the sentinel only on a new authorization.",
    );
  }

  const apiKey = process.env.CRUSTDATA_API_KEY?.trim();
  if (!apiKey) throw new Error("CRUSTDATA_API_KEY is not set.");

  // Self-check the authorized shape before spending anything.
  if (BODY.limit !== 1) throw new Error("limit must be 1 - more than one result would be billable");
  if (BODY.filters.conditions.length !== 1) throw new Error("exactly one condition is authorized");
  if (!("filters" in BODY) || "search" in BODY) throw new Error("no keyword/hybrid search is authorized");

  console.log("request  POST", ENDPOINT);
  console.log("body    ", JSON.stringify(BODY));
  console.log(`budget   max ${MAX_CREDITS} credits (0.03 per result, limit 1)\n`);

  writeFileSync(SENTINEL, `${new Date().toISOString()}\n${JSON.stringify(BODY)}\n`);

  // ONE fetch. No retry loop, no catch-and-try-again, no fallback body.
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
    console.log("body:", (await response.text()).slice(0, 400));
    console.log("\nNot ok. Stopping - no retry, no second request.");
    return;
  }

  const payload = (await response.json()) as { profiles?: unknown[]; total_count?: number };
  const profiles = payload.profiles ?? [];
  console.log(`results  ${profiles.length} profile(s), total_count=${payload.total_count ?? "(absent)"}`);

  if (Number(credits) > MAX_CREDITS) {
    console.log(`\nCHARGE EXCEEDED the authorized ${MAX_CREDITS}. No further request will be made.`);
  }

  console.log("\n--- top-level payload keys ---");
  console.log(Object.keys(payload).join(", "));

  if (!profiles.length) {
    console.log("\nNo profile returned - nothing to inspect. Stopping.");
    return;
  }

  const profile = profiles[0] as Record<string, unknown>;
  console.log("\n--- response field paths (types only, no personal values) ---");
  for (const line of shape(profile)) console.log(" ", line);

  // The question this request was for.
  const experience = (profile.experience ?? {}) as Record<string, unknown>;
  const details = (experience.employment_details ?? {}) as Record<string, unknown>;
  const current = (details.current ?? []) as Record<string, unknown>[];
  const past = (details.past ?? []) as Record<string, unknown>[];

  console.log("\n--- current employment, non-personal fields only ---");
  console.log(`current[] length: ${current.length}, past[] length: ${past.length}`);
  for (const [i, record] of current.entries()) {
    const shown = Object.fromEntries(
      Object.entries(record).filter(([k]) => SAFE_TO_PRINT.has(k)),
    );
    console.log(`  current[${i}] keys: ${Object.keys(record).join(", ")}`);
    console.log(`  current[${i}] safe values: ${JSON.stringify(shown)}`);
  }

  const idKey = current[0]
    ? (["company_id", "companyId", "company_uuid", "id"].find((k) => k in current[0]) ?? null)
    : null;
  console.log(`\nstable company identifier on current[0]: ${idKey ?? "NONE FOUND"}`);
  console.log(`start_date present: ${current[0] ? "start_date" in current[0] : "n/a"}`);
  console.log(`end_date present:   ${current[0] ? "end_date" in current[0] : "n/a"}`);

  // --- does the EXISTING parser work unchanged? ---------------------------
  // Pure functions. No network, no database, nothing written.
  console.log("\n--- existing parser, run against the real payload ---");
  const evidence = parseEmploymentEvidence(profile);
  console.log(`parseEmploymentEvidence -> current ${evidence.current.length}, past ${evidence.past.length}`);
  console.log(`  current[0].companyId = ${JSON.stringify(evidence.current[0]?.companyId ?? null)}`);
  console.log(`  current[0].startDate = ${JSON.stringify(evidence.current[0]?.startDate ?? null)}`);
  console.log(`  current[0].endDate   = ${JSON.stringify(evidence.current[0]?.endDate ?? null)}`);

  const verdict = confirmEmployment(evidence, { crustdataCompanyId: EVERCORE_COMPANY_ID });
  console.log(`confirmEmployment -> status=${verdict.status} basis=${verdict.basis}`);

  const mapped = fromCrustdataProfile(profile as Parameters<typeof fromCrustdataProfile>[0]);
  console.log(
    `fromCrustdataProfile -> name:${mapped.name ? "present" : "MISSING"} ` +
      `title:${mapped.title ? "present" : "missing"} ` +
      `linkedinUrl:${mapped.linkedinUrl ? "present" : "MISSING"} ` +
      `crustdataPersonId:${mapped.crustdataPersonId !== null ? "present" : "MISSING"} ` +
      `schools:${mapped.schools?.length ?? 0} gradYear:${mapped.gradYear !== null ? "present" : "missing"}`,
  );

  console.log("\nNothing was persisted. No enrichment, no resolution, no retry, no second request.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`PROBE FAILED: ${err instanceof Error ? err.message : err}`);
    console.error("No retry will be attempted.");
    process.exit(1);
  },
);
