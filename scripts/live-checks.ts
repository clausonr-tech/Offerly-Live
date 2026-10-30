// Every check that needs the network, in one place.
//
// These verify claims this codebase makes about the outside world - that a
// vendor's API tells a real board from a fake one, that a connector reads a
// real board, that honouring robots.txt costs no coverage. They were five
// separate scripts, which is five headers, five argument parsers and five
// fetch helpers to say "ask the internet and print what came back".
//
// Each remains independently runnable, because they cost real requests and
// nobody should have to run all of them to re-check one.
//
//   npx tsx --env-file=.env.local --conditions=react-server scripts/live-checks.ts <check>
//
//   probe        do the ATS APIs tell real tokens from fake ones?
//   getro        does the Getro connector read a real portfolio board?
//   connectors   do the 19 Sep connectors (Dayforce, BambooHR, Jobvite, Baird) read theirs?
//   robots       how much coverage does honouring robots.txt cost?
//   conditional  do any boards honour a conditional GET?
//   adjudicator  does the adjudicator recover a real internship?
//   all          every check above, in order
import { openScriptDb } from "./_db";
import * as schema from "../src/db/schema";
import { PROBE_PLATFORMS, BOGUS_TOKENS, type ProbePlatform } from "../src/lib/monitoring/ats-probe";
import { getroConnector, resolveNetworkId, parseGetroUrl } from "../src/lib/monitoring/connectors/getro";
import { getConnector } from "../src/lib/monitoring/connectors";
import { isAllowedByRobots } from "../src/lib/monitoring/robots";
import { adjudicateListing } from "../src/lib/monitoring/llm-adjudicate";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 OfferlyMonitor/1.0 (+internship listing monitor; contact via site)";
const TIMEOUT_MS = 15000;
const GAP_MS = 400;
/** Personio 429s a second request at the default pace, so a retry has to wait. */
const RETRY_BACKOFF_MS = 5000;

async function ask(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      headers: { "user-agent": UA, accept: "*/*", ...(init.headers ?? {}) },
      signal: controller.signal,
    });
    // NEVER truncated before parsing: a sliced JSON document fails to parse and
    // the board reads as empty. That cost a false failure on Ashby, whose board
    // is 73 postings.
    return { status: response.status, body: await response.text(), headers: response.headers };
  } catch (error) {
    return { status: 0, body: String(error), headers: new Headers() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whichever database the crawler is writing to.
 *
 * This used to be `new PGlite(...)`, which is how a script that exists to
 * verify the crawler's behaviour ended up verifying it against a directory
 * the crawler stopped writing to on 21 September 2026. See scripts/_db.ts.
 */
async function openLiveDb() {
  const { db, close } = await openScriptDb();
  return { db, close };
}

// ---------------------------------------------------------------- probe

async function askWithRetry(platform: ProbePlatform, token: string) {
  let res = await ask(platform.probeUrl(token));
  let outcome = platform.interpret(res.status, res.body);
  if (outcome.inconclusive) {
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    res = await ask(platform.probeUrl(token));
    outcome = platform.interpret(res.status, res.body);
  }
  return { res, outcome };
}

async function checkProbe() {
  console.log(`Probing ${PROBE_PLATFORMS.length} platforms: 1 known-good + ${BOGUS_TOKENS.length} controls each.\n`);
  for (const platform of PROBE_PLATFORMS) {
    const gap = platform.minGapMs ?? GAP_MS;
    const good = await askWithRetry(platform, platform.knownGoodToken);

    // Every control, not one. A platform that refuses a single string has only
    // proved it refuses that string - which is how Workable and Recruitee spent
    // a day looking like they accepted anything.
    const controls = [];
    for (const token of BOGUS_TOKENS) {
      await new Promise((r) => setTimeout(r, gap));
      controls.push(await askWithRetry(platform, token));
    }

    const accepted = controls.filter((c) => c.outcome.found).length;
    const unanswered = controls.filter((c) => c.outcome.inconclusive).length;
    const verdict =
      good.outcome.inconclusive || unanswered ? "RETRY" : good.outcome.found && !accepted ? "PASS" : "FAIL";

    console.log(
      `${verdict.padEnd(5)} ${platform.name.padEnd(16)} known-good "${platform.knownGoodToken}" -> ` +
        `${good.res.status} (${good.outcome.found ? `${good.outcome.listings} listings` : "no board"})   ` +
        `${BOGUS_TOKENS.length} controls -> ${accepted} accepted` +
        `${unanswered ? `, ${unanswered} unanswered` : ""}`,
    );
  }
}

// ---------------------------------------------------------------- getro

async function checkGetro() {
  const BOARD = "https://hv.getro.com/jobs";
  const parsed = parseGetroUrl(BOARD);
  if (!parsed) throw new Error("URL not recognised as a Getro board");
  const networkId = await resolveNetworkId(parsed.host);
  console.log(`collection id read from the board's own page state: ${networkId}`);

  const result = await getroConnector.fetch({ careersUrl: BOARD, sourceType: "generic_html", lastEtag: null });
  console.log(`HTTP ${result.httpStatus}, ${result.listings.length} listings`);

  // The properties a silent regression would break: the employer is carried
  // (a portfolio board is many employers), and created_at is unix SECONDS -
  // read as milliseconds every posting lands in 1970.
  const dated = result.listings.filter((l) => l.publishedAt && new Date(l.publishedAt).getUTCFullYear() >= 2020);
  console.log(`${result.listings.filter((l) => l.division).length}/${result.listings.length} carry an employer`);
  console.log(`${dated.length}/${result.listings.length} dated this decade`);
  for (const l of result.listings.slice(0, 5)) {
    console.log(`  ${l.title.slice(0, 52).padEnd(52)} | ${(l.division ?? "-").slice(0, 20)}`);
  }
  console.log(`${new Set(result.listings.map((l) => l.division)).size} distinct employers in one board.`);
}

// ------------------------------------------------------- the 19 Sep connectors

/**
 * Do the four connectors added on 19 September read their real boards?
 *
 * Every one of them was designed against a payload measured through a
 * BROWSER, because this session had no outbound network from Node. That is a
 * real gap and this check is what closes it: a browser carries cookies, runs
 * JavaScript and clears bot challenges on its own, and a server-side fetch
 * does none of those things.
 *
 * Dayforce is the one most likely to fail here. Its search endpoint answers
 * 403 to any body without an `x-csrf-token`, the token is a double-submit
 * paired with cookies from `/api/auth/session`, and the host sits behind
 * Cloudflare. If it 403s from Node, the connector needs the cookie handling
 * fixed - not the robots decision revisited, which is separate and settled.
 */
async function checkNewConnectors() {
  const boards: { id: string; firm: string; url: string; expect: number }[] = [
    { id: "dayforce", firm: "Stockbridge", url: "https://jobs.dayforcehcm.com/en-US/stockbridge/CANDIDATEPORTAL", expect: 2 },
    { id: "dayforce", firm: "Realterm", url: "https://jobs.dayforcehcm.com/en-US/Realterm/Candidateportal", expect: 4 },
    { id: "bamboohr", firm: "FCP", url: "https://fcp.bamboohr.com/careers/list", expect: 5 },
    { id: "bamboohr", firm: "Centurion", url: "https://centurion.bamboohr.com/careers/list", expect: 7 },
    { id: "jobvite", firm: "Starwood Capital", url: "https://jobs.jobvite.com/starwoodcapitalgroup/jobs", expect: 8 },
    { id: "baird", firm: "Robert W. Baird", url: "https://www.bairdcareers.com/jobs/", expect: 119 },
  ];

  for (const board of boards) {
    const connector = getConnector(board.id);
    let line: string;
    try {
      const result = await connector.fetch({
        careersUrl: board.url,
        sourceType: "generic_html",
        lastEtag: null,
      });
      const got = result.listings.length;
      // The count measured through the browser on 19 Sep. A board legitimately
      // moves, so this is reported rather than asserted - but zero against a
      // non-zero expectation is the shape of a broken connector.
      const verdict = got === 0 && board.expect > 0 ? "READS NOTHING" : "ok";
      line = `HTTP ${result.httpStatus}, ${got} listings (browser saw ${board.expect}) - ${verdict}`;
      for (const l of result.listings.slice(0, 3)) {
        line += `\n      ${l.title.slice(0, 60)}`;
      }
      // Every one of these connectors is meant to return a REAL source id -
      // that is what lets posting-quality.ts verify the listing instead of
      // treating it as something recovered from markup.
      const withIds = result.listings.filter((l) => l.externalJobId).length;
      if (result.listings.length) line += `\n      ${withIds}/${got} carry a source id`;
    } catch (error) {
      line = `THREW: ${error instanceof Error ? error.message : String(error)}`;
    }
    console.log(`  ${board.id.padEnd(9)} ${board.firm.padEnd(18)} ${line}`);
    await new Promise((r) => setTimeout(r, GAP_MS));
  }

  console.log(
    "\n  UltiPro is absent on purpose: robots.txt disallows the only endpoint\n" +
      "  that enumerates a board, re-verified unchanged 19 Sep. See repoint-sources.ts.",
  );
}

// ---------------------------------------------------------------- robots

async function checkRobots() {
  const { db, close: closeDb } = await openLiveDb();
  try {
    const sources = await db.select().from(schema.firmMonitoringSources);
    // Only the generic connector enforces robots - the specialist connectors
    // read documented vendor APIs assessed one at a time.
    const generic = sources.filter((s) => s.connectorId === "generic");
    console.log(`checking robots.txt for ${generic.length} generic sources\n`);
    let blocked = 0;
    for (const s of generic) {
      if (!(await isAllowedByRobots(s.careersUrl))) {
        blocked += 1;
        console.log(`  BLOCKED  ${s.careersUrl}`);
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    console.log(`\n${blocked} of ${generic.length} generic sources are disallowed.`);
    if (!blocked) console.log("Enforcement costs nothing today - it is insurance against the next discovered URL.");
  } finally {
    await closeDb();
  }
}

// ----------------------------------------------------------- conditional

async function checkConditional() {
  const { db, close: closeDb } = await openLiveDb();
  try {
    const sources = await db.select().from(schema.firmMonitoringSources);
    const byConnector = new Map<string, string>();
    for (const s of sources) if (!byConnector.has(s.connectorId)) byConnector.set(s.connectorId, s.careersUrl);

    for (const [connectorId, url] of [...byConnector].sort()) {
      if (connectorId === "generic") continue; // rendered, no conditional path
      const first = await ask(url);
      const etag = first.headers.get("etag");
      const lastModified = first.headers.get("last-modified");
      if (!etag && !lastModified) {
        console.log(`${connectorId.padEnd(16)} ${first.status}  ${String(first.body.length).padStart(8)}B  no validator offered`);
        continue;
      }
      const headers: Record<string, string> = {};
      if (etag) headers["if-none-match"] = etag;
      if (lastModified) headers["if-modified-since"] = lastModified;
      await new Promise((r) => setTimeout(r, 500));
      const second = await ask(url, { headers });
      console.log(
        `${connectorId.padEnd(16)} ${first.status}  ${String(first.body.length).padStart(8)}B  ` +
          `revalidate: ${second.status} ${second.status === 304 ? "<- WORTH WIRING" : "(ignored)"}`,
      );
      await new Promise((r) => setTimeout(r, 600));
    }
  } finally {
    await closeDb();
  }
}

// ----------------------------------------------------------- adjudicator

async function checkAdjudicator() {
  // Declining experienced-hire roles proves precision, not recall - and recall
  // is the whole reason this exists. This is the shape that lost 42 real
  // internships: a French title the phrase list cannot read.
  const result = await adjudicateListing({
    title: "Stage H/F - Private Equity - Janvier 2027",
    descriptionRaw:
      "Dans le cadre de son developpement, notre equipe Private Equity recherche un stagiaire " +
      "pour une duree de 6 mois a compter de janvier 2027. Ce stage s'adresse aux etudiants en " +
      "derniere annee d'ecole de commerce ou d'ingenieur. Vous participerez a l'analyse " +
      "financiere et a la modelisation. Les candidats doivent etre inscrits dans un " +
      "etablissement d'enseignement superieur pendant toute la duree du stage.",
  });
  console.log("outcome:", result.outcome);
  if (result.outcome === "internship") {
    console.log(`quote: "${result.adjudication.quote}"`);
  } else if ("reason" in result) {
    console.log("reason:", result.reason);
  }
}

const CHECKS: Record<string, () => Promise<void>> = {
  probe: checkProbe,
  getro: checkGetro,
  connectors: checkNewConnectors,
  robots: checkRobots,
  conditional: checkConditional,
  adjudicator: checkAdjudicator,
};

async function main() {
  const name = process.argv[2];
  if (!name || (!CHECKS[name] && name !== "all")) {
    console.error(`Usage: live-checks.ts <${Object.keys(CHECKS).join("|")}|all>`);
    process.exit(1);
  }
  for (const [key, run] of Object.entries(CHECKS)) {
    if (name !== "all" && name !== key) continue;
    console.log(`\n===== ${key} =====`);
    await run();
  }
  process.exit(0);
}

main();
